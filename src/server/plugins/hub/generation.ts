import { streamText, type LanguageModel } from 'ai'
import { DEFAULT_USER_ID, INFLIGHT_FLUSH_INTERVAL_MS } from '@/shared/constants'
import type { Message, PersistedStatus, SessionParams, Usage } from '@/shared/models'
import type { Part } from '@/shared/parts'
import type { SendCommand, WsCommand } from '@/shared/ws'
import type { ModelRow, ProviderRow, SessionRow } from '../../db/schema'
import { PartAccumulator } from '../llm/accumulator'
import { buildModelMessages, buildProviderOptions, type ImageBytes } from '../llm/messages'
import { toUsage } from '../llm/usage'
import type { Hub, InflightJob } from './index'
import {
  createSession, finalizeMessage, getAttachment, getMessage, getModel, getProvider, getSession,
  insertMessage, listMessages, maxSeq, toMessage, updateSession,
} from './sessions'
import { pathToRoot, titleFromParts } from './tree'

/** Payload of the `message/before-send` event: feature plugins may inspect or amend the prompt. */
export interface BeforeSendPayload {
  sessionId: number
  systemPrompt: string | null
  /** Root → leaf; plugins may mutate (convention: only the last element). */
  path: Message[]
}

interface Target {
  session: SessionRow
  provider: ProviderRow
  model: ModelRow
}

// ---- stage 1: resolve session + model

async function resolveTarget(
  hub: Hub,
  sessionId: number | null,
  providerId: number | null,
  modelId: string | null,
  firstParts: Part[],
): Promise<Target> {
  let session = sessionId === null ? undefined : await getSession(hub.db, sessionId)
  if (sessionId !== null && !session) throw new Error('session not found')
  const pid = providerId ?? session?.provider_id ?? null
  const mid = modelId ?? session?.model_id ?? null
  if (pid === null || mid === null) throw new Error('no model selected')
  const provider = await getProvider(hub.db, pid)
  if (!provider || !provider.enabled) throw new Error('provider not found')
  const model = await getModel(hub.db, pid, mid)
  if (!model) throw new Error('model not found')
  if (!session) {
    session = await createSession(hub.db, { user_id: DEFAULT_USER_ID, title: titleFromParts(firstParts), provider_id: pid, model_id: mid })
    hub.emitSessionCreated(session)
  } else if (session.provider_id !== pid || session.model_id !== mid) {
    session = await updateSession(hub.db, session.id, { provider_id: pid, model_id: mid })
    hub.emitSessionUpdated(session)
  }
  return { session, provider, model }
}

// ---- stage 2: persist a user message

async function persistUserMessage(hub: Hub, session: SessionRow, parentId: number | null, parts: Part[]): Promise<Message> {
  const seq = await hub.seq.allocate(session.id, () => maxSeq(hub.db, session.id))
  const row = await insertMessage(hub.db, {
    session_id: session.id, parent_id: parentId, seq, role: 'user', parts,
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: Date.now(),
  })
  const message = toMessage(row)
  hub.broadcast({ type: 'message.created', message })
  return message
}

// ---- stage 3: assistant shell (persisted as error until finalized) + head move

async function openAssistantShell(hub: Hub, target: Target, parentId: number): Promise<Message> {
  const seq = await hub.seq.allocate(target.session.id, () => maxSeq(hub.db, target.session.id))
  const row = await insertMessage(hub.db, {
    session_id: target.session.id, parent_id: parentId, seq, role: 'assistant', parts: [],
    provider_id: target.provider.id, model_id: target.model.model_id, usage: null,
    // "The DO died before finalizing" is the truthful reading of a row left in this state.
    status: 'error', error: 'interrupted', created_at: Date.now(),
  })
  const message = toMessage(row, 'streaming')
  hub.broadcast({ type: 'message.created', message })
  const session = await updateSession(hub.db, target.session.id, { head_message_id: row.id })
  hub.broadcast({ type: 'head.changed', session_id: session.id, message_id: row.id })
  hub.emitSessionUpdated(session)
  return message
}

// ---- stage 4: context assembly

async function assembleContext(hub: Hub, session: SessionRow, leafUserId: number): Promise<{ path: Message[]; images: Map<number, ImageBytes> }> {
  const rows = await listMessages(hub.db, session.id)
  const byId = new Map(rows.map((r) => [r.id, toMessage(r)]))
  const path = pathToRoot(byId, leafUserId)
  const images = new Map<number, ImageBytes>()
  for (const m of path) {
    for (const p of m.parts) {
      if (p.type !== 'image' || images.has(p.attachment_id)) continue
      const att = await getAttachment(hub.db, p.attachment_id)
      if (!att) throw new Error(`attachment ${p.attachment_id} missing`)
      const stored = await hub.app.assets.getBytes(att.r2_key)
      if (!stored) throw new Error(`attachment ${p.attachment_id} bytes missing`)
      images.set(p.attachment_id, { bytes: stored.bytes, mime: att.mime })
    }
  }
  return { path, images }
}

// ---- stage 5/6: stream + finalize

async function generate(hub: Hub, target: Target, shell: Message, leafUserId: number): Promise<void> {
  const controller = new AbortController()
  const acc = new PartAccumulator()
  const job = { message: shell, sessionId: target.session.id, controller, startedAt: Date.now(), parts: acc.parts }
  // `trackInflight` assigns `settled` onto this very object, so the reference stays usable.
  await hub.trackInflight(job)
  const tracked = job as InflightJob

  let status: PersistedStatus = 'done'
  let error: string | null = null
  let usage: Usage | null = null

  try {
    const { path, images } = await assembleContext(hub, target.session, leafUserId)
    const payload: BeforeSendPayload = { sessionId: target.session.id, systemPrompt: target.session.system_prompt, path }
    hub.app.emit('message/before-send', payload)

    const messages = buildModelMessages({ protocol: target.provider.protocol, systemPrompt: payload.systemPrompt, path: payload.path, images })
    const params: SessionParams = target.session.params ?? {}
    const model: LanguageModel = await hub.app.llm.createModel(target.provider, target.model)

    const result = streamText({
      model,
      messages,
      // The system prompt travels as a `role: 'system'` message so cache breakpoints can attach to it.
      allowSystemInMessages: true,
      abortSignal: controller.signal,
      temperature: params.temperature,
      topP: params.top_p,
      maxOutputTokens: params.max_tokens,
      providerOptions: buildProviderOptions(target.provider.protocol, params, target.model.capabilities) as never,
    })

    let lastFlush = Date.now()
    for await (const part of result.stream) {
      if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error))
      // An aborted stream ends with `abort` and never emits `finish`, so usage stays null.
      if (part.type === 'abort') { status = 'aborted'; break }
      if (part.type === 'finish') { usage = toUsage(part.totalUsage); continue }
      for (const ev of acc.apply(part)) {
        if (ev.kind === 'delta') hub.broadcast({ type: 'message.delta', message_id: shell.id, part_index: ev.part_index, kind: ev.part_kind, delta: ev.delta })
        else hub.broadcast({ type: 'message.part', message_id: shell.id, part_index: ev.part_index, part: ev.part })
      }
      if (Date.now() - lastFlush > INFLIGHT_FLUSH_INTERVAL_MS) {
        lastFlush = Date.now()
        await hub.flushInflight(tracked)
      }
    }
    if (controller.signal.aborted) status = 'aborted'
  } catch (err) {
    if (controller.signal.aborted) {
      status = 'aborted'
    } else {
      status = 'error'
      error = err instanceof Error ? err.message : String(err)
      console.error('generation failed', err)
    }
  } finally {
    // `hub.stop()` waits on the settled promise that `untrackInflight` resolves, so no exit path
    // may skip it — not even a failing finalize.
    try {
      await finalizeMessage(hub.db, shell.id, { parts: acc.parts, usage, status, error })
    } finally {
      await hub.untrackInflight(shell.id)
    }
  }

  const final: Message = { ...shell, parts: acc.parts, usage, status, error }
  hub.broadcast({ type: 'message.done', message_id: shell.id, status, usage, error })
  hub.app.emit('message/done', final)
}

// ---- entry points

export async function runSend(hub: Hub, cmd: SendCommand): Promise<void> {
  const target = await resolveTarget(hub, cmd.session_id, cmd.provider_id, cmd.model_id, cmd.parts)
  const parentId = cmd.session_id === null ? null : (cmd.parent_id ?? target.session.head_message_id)
  const user = await persistUserMessage(hub, target.session, parentId, cmd.parts)
  const shell = await openAssistantShell(hub, target, user.id)
  await generate(hub, target, shell, user.id)
}

export async function runRegenerate(hub: Hub, cmd: Extract<WsCommand, { type: 'regenerate' }>): Promise<void> {
  const old = await getMessage(hub.db, cmd.message_id)
  if (!old || old.role !== 'assistant' || old.parent_id === null) throw new Error('not an assistant message')
  const target = await resolveTarget(hub, old.session_id, cmd.provider_id ?? null, cmd.model_id ?? null, [])
  const shell = await openAssistantShell(hub, target, old.parent_id)
  await generate(hub, target, shell, old.parent_id)
}

export async function runEdit(hub: Hub, cmd: Extract<WsCommand, { type: 'edit' }>): Promise<void> {
  const old = await getMessage(hub.db, cmd.message_id)
  if (!old || old.role !== 'user') throw new Error('not a user message')
  const target = await resolveTarget(hub, old.session_id, null, null, cmd.parts)
  const user = await persistUserMessage(hub, target.session, old.parent_id, cmd.parts)
  const shell = await openAssistantShell(hub, target, user.id)
  await generate(hub, target, shell, user.id)
}
