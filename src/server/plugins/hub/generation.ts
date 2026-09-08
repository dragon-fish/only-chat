import { streamText, type LanguageModel, type ToolSet } from 'ai'
import { DEFAULT_USER_ID, INFLIGHT_FLUSH_INTERVAL_MS } from '@/shared/constants'
import type { Message, PersistedStatus, SessionParams, Usage } from '@/shared/models'
import type { Part, ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { SendCommand, WsCommand } from '@/shared/ws'
import { ASK_USER_TOOL_ID } from '@/shared/plugins'
import { AskUserInputSchema, AskUserResultSchema, validateAskUserResult } from '@/plugins/ask-user/shared'
import type { ModelRow, ProviderInterfaceRow, ProviderRow, SessionRow } from '../../db/schema'
import { PartAccumulator } from '../llm/accumulator'
import { buildModelMessages, buildProviderOptions, requiredAttachmentIds, type AttachmentInput } from '../llm/messages'
import { toUsage } from '../llm/usage'
import type { Hub, InflightJob } from './index'
import {
  resolveEffectiveConfig,
  type EffectiveConfig, type EffectiveModel, type ModelSource, type SessionConfigSource,
} from './effective-config'
import { persistGeneratedImage } from './generated-images'
import { getProject } from './projects'
import {
  appendToolResult, createSession, finalizeMessage, getMessage, getModel, getProvider, getProviderInterface, getSession, getUser,
  insertAssistantChildIfAbsent, insertMessage, lastGenerationModel, listAssistantChildren, listMessages, maxSeq, toMessage, updateSession,
} from './sessions'
import { resolveAttachmentInputs } from './attachment-transport'
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
  providerInterface: ProviderInterfaceRow
  model: ModelRow
  /**
   * Snapshot taken once, at generation start; never re-read while the stream runs (spec §3.2).
   * `resolveTarget` has already proved the model resolved, so consumers never re-check it.
   */
  config: EffectiveConfig & { model: EffectiveModel }
  tools: ToolSet
}

/** The session-init draft carried by the first `send` of a new session (spec §5.2). */
interface SessionDraft extends SessionConfigSource {
  project_id: number | null
  tools: string[]
}

const EMPTY_DRAFT: SessionDraft = { project_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, tools: [] }

interface ResolveArgs {
  sessionId: number | null
  /** The client's current selection — the last layer of the precedence chain. */
  fallbackModel?: { provider_id: number; model_id: string }
  /**
   * A deliberate one-shot choice for this generation alone (`regenerate` with a model). It beats
   * both inheritance layers, and is never persisted onto the session.
   */
  explicitModel?: { provider_id: number; model_id: string }
  /** Parts of the first user message, used to title a session created here. */
  firstParts: Part[]
  /** Only meaningful when `sessionId` is null. */
  draft?: SessionDraft
}

function modelUnavailable(source: ModelSource): Error {
  if (source === 'project') return new Error('模型不可用（来源：Project）')
  if (source === 'session') return new Error('模型不可用（来源：会话）')
  return new Error('模型不可用')
}

// ---- stage 1: resolve session + effective config + model

async function resolveTarget(hub: Hub, args: ResolveArgs): Promise<Target> {
  const existing = args.sessionId === null ? undefined : await getSession(hub.db, args.sessionId)
  if (args.sessionId !== null && !existing) throw new Error('session not found')

  // For a new session the draft stands in for the row that does not exist yet, so an unavailable
  // inherited model is rejected before anything is persisted.
  const draft: SessionDraft = existing ?? args.draft ?? EMPTY_DRAFT
  const project = draft.project_id === null ? undefined : await getProject(hub.db, draft.project_id, DEFAULT_USER_ID)
  if (draft.project_id !== null && !project) throw new Error('project not found')

  const resolved = resolveEffectiveConfig({ session: draft, project, fallbackModel: args.fallbackModel })
  // Only the model layer is overridden; the prompt and params keep inheriting as usual.
  const effectiveModel = args.explicitModel ? { ...args.explicitModel, source: 'command' as const } : resolved.model
  if (!effectiveModel) throw new Error('no model selected')
  const config = { ...resolved, model: effectiveModel }

  const provider = await getProvider(hub.db, effectiveModel.provider_id)
  const model = provider ? await getModel(hub.db, provider.id, effectiveModel.model_id) : undefined
  if (!provider || !provider.enabled || !model || !model.enabled) throw modelUnavailable(effectiveModel.source)
  const interfaceId = model.interface_id ?? provider.default_interface_id
  const providerInterface = interfaceId === null ? undefined : await getProviderInterface(hub.db, interfaceId)
  if (!providerInterface || providerInterface.provider_id !== provider.id) throw new Error('model interface is unavailable')

  const user = await getUser(hub.db, DEFAULT_USER_ID)
  if (!user) throw new Error('user missing')
  const resolvedTools = hub.app.tools.resolve(draft.tools, user.settings.plugins)
  if (resolvedTools.length > 0 && model.metadata_resolved.tool_call !== true) {
    throw new Error('当前模型不支持工具调用，请取消所选工具或更换模型')
  }
  const tools = Object.fromEntries(resolvedTools)

  // The persisted override is the draft's, never this generation's model: copying the latter down
  // would silently end the session's Project inheritance.
  const session = existing ?? await createSession(hub.db, {
    user_id: DEFAULT_USER_ID,
    title: titleFromParts(args.firstParts),
    project_id: draft.project_id,
    system_prompt: draft.system_prompt,
    params: draft.params,
    tools: draft.tools,
    provider_id: draft.provider_id,
    model_id: draft.model_id,
  })
  if (!existing) hub.emitSessionCreated(session)
  return { session, provider, providerInterface, model, config, tools }
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

async function openContinuationShell(hub: Hub, target: Target, parentId: number): Promise<Message | undefined> {
  const seq = await hub.seq.allocate(target.session.id, () => maxSeq(hub.db, target.session.id))
  const row = await insertAssistantChildIfAbsent(hub.db, {
    session_id: target.session.id, parent_id: parentId, seq, role: 'assistant', parts: [],
    provider_id: target.provider.id, model_id: target.model.model_id, usage: null,
    status: 'error', error: 'interrupted', created_at: Date.now(),
  })
  if (!row) return undefined
  const message = toMessage(row, 'streaming')
  hub.broadcast({ type: 'message.created', message })
  const session = await updateSession(hub.db, target.session.id, { head_message_id: row.id })
  hub.broadcast({ type: 'head.changed', session_id: session.id, message_id: row.id })
  hub.emitSessionUpdated(session)
  return message
}

// ---- stage 4: context assembly

async function assembleContext(hub: Hub, target: Target, leafMessageId: number): Promise<{ path: Message[]; attachments: Map<number, AttachmentInput> }> {
  const rows = await listMessages(hub.db, target.session.id)
  const byId = new Map(rows.map((r) => [r.id, toMessage(r)]))
  const path = pathToRoot(byId, leafMessageId)
  // Which ids the request needs is the message builder's own answer, not a second one kept in step
  // by convention: a part it drops must never be resolved here.
  const ids = requiredAttachmentIds(path)
  // Attachment transport shares this generation's resolved interface and credentials snapshot.
  const deps = { db: hub.db, assets: hub.app.assets, llm: hub.app.llm }
  return { path, attachments: await resolveAttachmentInputs(deps, target.provider, target.providerInterface, ids) }
}

// ---- stage 5/6: stream + finalize

async function generate(hub: Hub, target: Target, shell: Message, leafMessageId: number): Promise<void> {
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
    const { path, attachments } = await assembleContext(hub, target, leafMessageId)
    const payload: BeforeSendPayload = { sessionId: target.session.id, systemPrompt: target.config.systemPrompt, path }
    hub.app.emit('message/before-send', payload)

    const messages = buildModelMessages({ protocol: target.providerInterface.protocol, systemPrompt: payload.systemPrompt, path: payload.path, attachments })
    const params: SessionParams = target.config.params
    const trace = {
      sessionId: target.session.id,
      messageId: shell.id,
      providerId: target.provider.id,
      interfaceId: target.providerInterface.id,
      protocol: target.providerInterface.protocol,
      modelId: target.model.model_id,
    }
    const model: LanguageModel = await hub.app.llm.createModel(target.provider, target.providerInterface, target.model, trace)

    const requestStartedAt = performance.now()
    let firstTokenAt: number | null = null
    const result = streamText({
      model,
      messages,
      tools: target.tools,
      // The system prompt travels as a `role: 'system'` message so cache breakpoints can attach to it.
      allowSystemInMessages: true,
      // Responses raw deltas preserve full-text versus summary provenance before SDK normalization.
      include: { rawChunks: target.providerInterface.protocol === 'responses' },
      abortSignal: controller.signal,
      temperature: params.temperature,
      topP: params.top_p,
      maxOutputTokens: params.max_tokens,
      providerOptions: buildProviderOptions(target.providerInterface.protocol, params, target.model.metadata_resolved),
    })

    let lastFlush = Date.now()
    for await (const part of result.stream) {
      if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error))
      // An aborted stream ends with `abort` and never emits `finish`, so usage stays null.
      if (part.type === 'abort') { status = 'aborted'; break }
      if (part.type === 'finish') {
        usage = toUsage(part.totalUsage, { requestStartedAt, firstTokenAt, finishedAt: performance.now() })
        console.info(JSON.stringify({ event: 'llm.generation.usage', ...trace, usage, rawUsage: part.totalUsage.raw ?? null }))
        continue
      }
      // Awaited before anything else sees the part: the accumulator, the inflight snapshot, D1 and
      // every socket may only ever carry the attachment id it returns (spec §5.8).
      if (part.type === 'file') {
        const image = await persistGeneratedImage(hub, part.file)
        const ev = acc.append(image)
        hub.broadcast({ type: 'message.part', message_id: shell.id, part_index: ev.part_index, part: ev.part })
        await hub.flushInflight(tracked)
        continue
      }
      for (const ev of acc.apply(part)) {
        if (part.type === 'tool-call' && ev.kind === 'part' && ev.part.type === 'tool_call' && ev.part.name === ASK_USER_TOOL_ID) {
          AskUserInputSchema.parse(ev.part.args)
        }
        if (ev.kind === 'delta') {
          if (firstTokenAt === null && ev.delta.length > 0) firstTokenAt = performance.now()
          hub.broadcast({ type: 'message.delta', message_id: shell.id, part_index: ev.part_index, kind: ev.part_kind, delta: ev.delta })
        }
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
  }

  // Spec §8.3 step 4, in this order on every exit path: UPDATE D1 → broadcast the terminal event →
  // untrack. A failing finalize must not swallow `message.done`, or the client bubble would stay
  // `streaming` forever with nothing left in `inflight` for a snapshot to recover; its error is
  // therefore captured and rethrown only at the very end. `untrackInflight` resolves the promise
  // `hub.stop()` awaits, so it comes last: by the time `stop()` (and thus `sessionDelete`) returns,
  // every socket already has the terminal event.
  let finalizeFailure: { err: unknown } | null = null
  try {
    await finalizeMessage(hub.db, shell.id, { parts: acc.parts, usage, status, error })
  } catch (err) {
    finalizeFailure = { err }
    console.error('finalize failed for message', shell.id, err)
  }
  try {
    const final: Message = { ...shell, parts: acc.parts, usage, status, error }
    hub.broadcast({ type: 'message.done', message_id: shell.id, status, usage, error })
    hub.app.emit('message/done', final)
  } finally {
    await hub.untrackInflight(shell.id)
  }
  if (finalizeFailure) throw finalizeFailure.err
}

// ---- entry points

/** Fields that initialize a brand-new session and are therefore meaningless on an existing one. */
const INIT_FIELDS = ['project_id', 'system_prompt', 'params', 'session_provider_id', 'session_model_id', 'tools'] as const

export async function runSend(hub: Hub, cmd: SendCommand): Promise<void> {
  // Dropping them silently would let a client believe it had changed a session's settings (spec §9).
  if (cmd.session_id !== null && INIT_FIELDS.some((k) => cmd[k] !== undefined)) {
    throw new Error('session init fields are only allowed when session_id is null')
  }
  const target = await resolveTarget(hub, {
    sessionId: cmd.session_id,
    fallbackModel: { provider_id: cmd.provider_id, model_id: cmd.model_id },
    firstParts: cmd.parts,
    draft: {
      project_id: cmd.project_id ?? null,
      system_prompt: cmd.system_prompt ?? null,
      params: cmd.params ?? null,
      provider_id: cmd.session_provider_id ?? null,
      model_id: cmd.session_model_id ?? null,
      tools: hub.app.tools.normalize(cmd.tools ?? []),
    },
  })
  const parentId = cmd.session_id === null ? null : (cmd.parent_id ?? target.session.head_message_id)
  const user = await persistUserMessage(hub, target.session, parentId, cmd.parts)
  const shell = await openAssistantShell(hub, target, user.id)
  await generate(hub, target, shell, user.id)
}

export async function runRegenerate(hub: Hub, cmd: Extract<WsCommand, { type: 'regenerate' }>): Promise<void> {
  const old = await getMessage(hub.db, cmd.message_id)
  if (!old || old.role !== 'assistant' || old.parent_id === null) throw new Error('not an assistant message')
  // "Redo this reply with model X" is an explicit one-shot choice, so it outranks inheritance.
  // Without one, regenerate reuses the model that produced the reply being replaced.
  const explicitModel = cmd.provider_id !== undefined && cmd.model_id !== undefined
    ? { provider_id: cmd.provider_id, model_id: cmd.model_id }
    : undefined
  const fallbackModel = old.provider_id !== null && old.model_id !== null
    ? { provider_id: old.provider_id, model_id: old.model_id }
    : undefined
  const target = await resolveTarget(hub, { sessionId: old.session_id, explicitModel, fallbackModel, firstParts: [] })
  const shell = await openAssistantShell(hub, target, old.parent_id)
  await generate(hub, target, shell, old.parent_id)
}

export async function runEdit(hub: Hub, cmd: Extract<WsCommand, { type: 'edit' }>): Promise<void> {
  const old = await getMessage(hub.db, cmd.message_id)
  if (!old || old.role !== 'user') throw new Error('not a user message')
  // `edit` carries no model, so the session's last generation stands in as the command layer.
  const fallbackModel = await lastGenerationModel(hub.db, old.session_id)
  const target = await resolveTarget(hub, { sessionId: old.session_id, fallbackModel, firstParts: cmd.parts })
  const user = await persistUserMessage(hub, target.session, old.parent_id, cmd.parts)
  const shell = await openAssistantShell(hub, target, user.id)
  await generate(hub, target, shell, user.id)
}

function toolResultFor(parts: Part[], callId: string): ToolResultPart | undefined {
  return parts.find((part): part is ToolResultPart => part.type === 'tool_result' && part.call_id === callId)
}

function toolCallFor(parts: Part[], callId: string): ToolCallPart | undefined {
  return parts.find((part): part is ToolCallPart => part.type === 'tool_call' && part.id === callId)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function ownedTerminalToolMessage(hub: Hub, messageId: number) {
  const message = await getMessage(hub.db, messageId)
  if (!message || message.role !== 'assistant') throw new Error('tool-call message not found')
  const session = await getSession(hub.db, message.session_id)
  if (!session || session.user_id !== DEFAULT_USER_ID) throw new Error('tool-call message not found')
  if (hub.inflight().some(job => job.message.id === messageId) || message.status !== 'done') {
    throw new Error('cannot respond to a streaming or incomplete message')
  }
  return { message, session }
}

function completedToolState(parts: Part[]): 'waiting' | 'cancelled' | 'answered' {
  const calls = parts.filter(part => part.type === 'tool_call')
  if (calls.length === 0) throw new Error('message has no tool calls')
  const results = new Map(parts.filter(part => part.type === 'tool_result').map(part => [part.call_id, part]))
  if (calls.some(call => !results.has(call.id))) return 'waiting'
  for (const call of calls) {
    if (call.name !== ASK_USER_TOOL_ID) throw new Error(`unsupported pending tool: ${call.name}`)
    const result = AskUserResultSchema.parse(results.get(call.id)!.content)
    if (result.status === 'cancelled') return 'cancelled'
  }
  return 'answered'
}

async function continueFromToolMessage(hub: Hub, messageId: number, requireHead: boolean): Promise<void> {
  const { message, session } = await ownedTerminalToolMessage(hub, messageId)
  const state = completedToolState(message.parts)
  if (state === 'waiting') throw new Error('tool calls are still waiting for responses')
  if (state === 'cancelled') throw new Error('cancelled tool calls cannot continue automatically')

  const reconcileChildHead = async (child: Message, rejectOtherHead: boolean): Promise<void> => {
    const current = await getSession(hub.db, session.id)
    if (!current) throw new Error('session not found')
    if (current.head_message_id === child.id) return
    if (current.head_message_id !== message.id) {
      if (rejectOtherHead) throw new Error('tool-call message is no longer the session head')
      return
    }
    const updated = await updateSession(hub.db, current.id, { head_message_id: child.id })
    hub.broadcast({ type: 'head.changed', session_id: updated.id, message_id: child.id })
    hub.emitSessionUpdated(updated)
  }

  const existingChildren = await listAssistantChildren(hub.db, message.id)
  if (existingChildren.length > 1) throw new Error('tool-call message has multiple continuation children')
  if (existingChildren.length === 1) {
    const child = toMessage(existingChildren[0]!)
    await reconcileChildHead(child, requireHead)
    return
  }
  if (requireHead && session.head_message_id !== message.id) throw new Error('tool-call message is no longer the session head')

  const fallbackModel = message.provider_id !== null && message.model_id !== null
    ? { provider_id: message.provider_id, model_id: message.model_id }
    : await lastGenerationModel(hub.db, message.session_id)
  const target = await resolveTarget(hub, { sessionId: message.session_id, fallbackModel, firstParts: [] })
  const shell = await openContinuationShell(hub, target, message.id)
  if (!shell) {
    const raced = await listAssistantChildren(hub.db, message.id)
    if (raced.length !== 1) throw new Error('continuation child could not be resolved')
    await reconcileChildHead(toMessage(raced[0]!), requireHead)
    return
  }
  await generate(hub, target, shell, message.id)
}

export async function runToolRespond(hub: Hub, cmd: Extract<WsCommand, { type: 'tool.respond' }>): Promise<void> {
  const { message } = await ownedTerminalToolMessage(hub, cmd.message_id)
  const call = toolCallFor(message.parts, cmd.call_id)
  if (!call) throw new Error('tool call not found')
  if (call.name !== ASK_USER_TOOL_ID) throw new Error(`unsupported tool: ${call.name}`)

  const input = AskUserInputSchema.parse(call.args)
  const result = validateAskUserResult(input, AskUserResultSchema.parse(cmd.result))
  const part = { type: 'tool_result' as const, call_id: call.id, name: call.name, content: result }
  const appended = await appendToolResult(hub.db, message.id, message.session_id, part)
  if (!appended) {
    const current = await getMessage(hub.db, message.id)
    const existing = current && toolResultFor(current.parts, call.id)
    if (!existing || existing.name !== part.name || !sameJson(existing.content, part.content)) {
      throw new Error('tool result conflict')
    }
    if (current && completedToolState(current.parts) === 'answered') {
      await continueFromToolMessage(hub, current.id, false)
    }
    return
  }

  const updated = await getMessage(hub.db, message.id)
  if (!updated) throw new Error('tool-call message disappeared')
  hub.broadcast({
    type: 'message.part', message_id: updated.id, part_index: updated.parts.length - 1,
    part: updated.parts.at(-1)!,
  })
  if (completedToolState(updated.parts) === 'answered') await continueFromToolMessage(hub, updated.id, false)
}

export async function runToolContinue(hub: Hub, cmd: Extract<WsCommand, { type: 'tool.continue' }>): Promise<void> {
  await continueFromToolMessage(hub, cmd.message_id, true)
}
