import type { ToolSet } from 'ai'
import type { Message, StepUsage, Usage } from '@/shared/models'
import type { CheckpointPart } from '@/shared/parts'
import { checkpointOf } from '@/shared/checkpoint'
import type {
  ActiveContextManager, CompactionTrigger, ComposeRequest, ComposeTurn, ContextDecision, ContextModel, MeasuredStep, TurnInput,
} from '../context-manager'
import { INTERJECTED } from '../llm/messages'
import { projectContext } from './checkpoint'
import { listMessages, toMessage } from './conversations'
import type { OperationHandle } from './operations'
import { pathToRoot } from './tree'
import type { Hub } from './index'
import type { Target } from './generation'

export type CompactionOutcome = { ok: true, message: Message } | { ok: false, error: string }

/**
 * Logical-turn state shared by a reply and the continuations compaction starts under it (spec §2).
 * A continuation is the same turn: it spends what is left of the step budget, and a turn retries
 * an overflow once however many continuations it runs.
 */
export interface LogicalTurn {
  stepsUsed: number
  overflowRetried: boolean
  /** The turn's user-side inputs so far, in order; what a mid-turn checkpoint carries on. */
  inputs: Message[]
}

export function contextModelOf(target: Pick<Target, 'provider' | 'providerInterface' | 'model'>): ContextModel {
  const metadata = target.model.metadata_resolved
  return {
    providerId: target.provider.id,
    modelId: target.model.model_id,
    protocol: target.providerInterface.protocol,
    metadata,
    contextLimit: metadata.limit?.context ?? null,
  }
}

/** The latest request with recorded usage on `visible`: the last step of the newest reply that has one. */
export function lastMeasuredStep(visible: readonly Message[]): MeasuredStep | null {
  for (let index = visible.length - 1; index >= 0; index--) {
    const message = visible[index]!
    if (message.role !== 'assistant' || !message.usage) continue
    const step = message.usage.steps?.at(-1)
    if (step) return { usage: step, messageId: message.id }
    const { prompt, completion, cached, reasoning } = message.usage
    if (prompt !== undefined) return { usage: { prompt, completion, cached, reasoning }, messageId: message.id }
  }
  return null
}

export function turnInputOf(hub: Hub, target: Target, path: readonly Message[]): TurnInput {
  const projection = projectContext(path)
  return {
    userId: hub.userId, conversationId: target.conversation.id, projectId: target.conversation.project_id,
    model: contextModelOf(target), projection, lastStep: lastMeasuredStep(projection.visible),
  }
}

/** The run's usage summed from its completed steps, for a reply whose failed last step never finished. */
export function usageFromSteps(steps: readonly StepUsage[]): Usage | null {
  if (steps.length === 0) return null
  const sum = (key: keyof StepUsage) => steps.some(step => step[key] !== undefined)
    ? steps.reduce((total, step) => total + (step[key] ?? 0), 0)
    : undefined
  const out: Usage = { steps: [...steps] }
  for (const key of ['prompt', 'completion', 'cached', 'reasoning'] as const) {
    const value = sum(key)
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Whether `user` continues the turn of the message before it rather than starting one: it was
 * said mid-turn (the reply before it was taken over), or it is a task notification handed in
 * between two steps, which only ever follows a reply that ended on its tool results.
 */
function continuesTurn(user: Message, previous: Message | undefined): boolean {
  if (!previous || previous.role !== 'assistant') return false
  if (previous.error === INTERJECTED) return true
  return user.parts.length > 0 && user.parts.every(part => part.type === 'task_notification')
    && previous.parts.at(-1)?.type === 'tool_result'
}

/**
 * The user-side inputs of the turn `path` ends in, in order: its user message, then what was
 * interjected and delivered while it ran. Checkpoints are transparent — a turn compacted mid-way
 * still began at the same user message.
 */
export function turnInputsOnPath(path: readonly Message[]): Message[] {
  const messages = path.filter(message => !checkpointOf(message))
  const inputs: Message[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    inputs.unshift(message)
    if (!continuesTurn(message, messages[index - 1])) break
  }
  return inputs
}

export function inputAttachmentIds(inputs: readonly Message[]): number[] {
  const ids = new Set<number>()
  for (const message of inputs) {
    for (const part of message.parts) {
      if (part.type === 'image' || part.type === 'file') ids.add(part.attachment_id)
      if (part.type === 'task_notification') for (const id of part.attachments ?? []) ids.add(id)
    }
  }
  return [...ids]
}

/** Tool definitions a summary request may carry: never anything it could run. */
export function definitionsOnly(tools: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, entry]) => {
    const { execute: _execute, ...definition } = entry
    return [name, definition]
  })) as ToolSet
}

export async function pathTo(hub: Hub, conversationId: number, leafMessageId: number): Promise<Message[]> {
  const byId = new Map((await listMessages(hub.db, conversationId, hub.userId)).map(row => [row.id, toMessage(row)]))
  return pathToRoot(byId, leafMessageId)
}

/** A hook's answer; one that throws is logged and counts as 'continue'. */
export async function decide(hook: () => ContextDecision | Promise<ContextDecision>): Promise<ContextDecision> {
  try {
    return (await hook()) === 'checkpoint' ? 'checkpoint' : 'continue'
  } catch (error) {
    console.error('context manager hook failed', error)
    return 'continue'
  }
}

export function isOverflow(active: ActiveContextManager, error: unknown): boolean {
  try {
    return active.manager.isOverflow(error) === true
  } catch (err) {
    console.error('context manager isOverflow failed', err)
    return false
  }
}

/** The lock, or nothing when something else already holds the conversation. */
export function tryAcquire(hub: Hub, conversationId: number): OperationHandle | undefined {
  try {
    return hub.operations.acquire(conversationId)
  } catch {
    return undefined
  }
}

export interface CompactionJob {
  trigger: CompactionTrigger
  /** The head the checkpoint goes under; nothing is written if it moved. */
  expectedHead: number
  /** Set when the turn goes on after the checkpoint. */
  turn: { inputs: readonly Message[], pendingToolAttachments: readonly number[] } | null
  focus: string | null
}

/** Builds the turn's request for `compose`, and releases what building it opened once it is done. */
export type ComposeRequestSource = (signal: AbortSignal) => Promise<{ request: ComposeRequest, dispose?: () => Promise<void> }>

/**
 * One compaction under a held conversation (spec §1.4, §2): collect plugin blocks, have the context
 * manager write the summary, write the checkpoint under `expectedHead`. Writes nothing on any
 * failure — a refused draft, a thrown error, a stop, a moved head — and reports every one through
 * `checkpoint/failed`. Never releases `handle`: what follows a checkpoint has to start under it.
 */
export async function compactConversation(
  hub: Hub,
  target: Target,
  active: ActiveContextManager,
  handle: OperationHandle,
  job: CompactionJob,
  source: ComposeRequestSource,
): Promise<CompactionOutcome> {
  const conversationId = target.conversation.id
  const fail = (error: string): CompactionOutcome => {
    try {
      hub.app.emit('checkpoint/failed', { userId: hub.userId, conversationId, trigger: job.trigger, error })
    } catch (err) {
      console.error('checkpoint/failed listener failed', err)
    }
    return { ok: false, error }
  }
  const stopped = () => fail(String(handle.signal.reason ?? 'aborted'))
  try {
    if (handle.signal.aborted) return stopped()
    const path = await pathTo(hub, conversationId, job.expectedHead)
    const { blocks, contributors } = await hub.checkpoints.compose({
      conversationId, projectId: target.conversation.project_id, toolIds: target.toolIds, path,
    })
    if (handle.signal.aborted) return stopped()
    const turn: ComposeTurn | null = job.turn
      ? { inputs: job.turn.inputs, attachments: inputAttachmentIds(job.turn.inputs), pendingToolAttachments: job.turn.pendingToolAttachments }
      : null
    const built = await source(handle.signal)
    let draft: Awaited<ReturnType<ActiveContextManager['manager']['compose']>>
    try {
      draft = await active.manager.compose({
        ...built.request,
        trigger: job.trigger, userId: hub.userId, conversationId, projectId: target.conversation.project_id,
        model: contextModelOf(target), projection: projectContext(path), blocks, contributors,
        signal: handle.signal, turn, focus: job.focus,
      })
    } finally {
      await built.dispose?.().catch(error => console.error('releasing a compaction request failed', error))
    }
    if (handle.signal.aborted) return stopped()
    if ('error' in draft) return fail(draft.error)
    const part: CheckpointPart = {
      type: 'checkpoint', plugin: active.pluginId, content: draft.content, attachments: draft.attachments,
      contributors, data: draft.data,
    }
    const message = await hub.checkpoints.commit({ conversationId, expectedHead: job.expectedHead, part, usage: draft.usage })
    if (!message) return fail('conversation head changed')
    return { ok: true, message }
  } catch (error) {
    console.error('compaction failed', error)
    return fail(error instanceof Error ? error.message : String(error))
  }
}
