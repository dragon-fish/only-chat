import type { Message } from '@/shared/models'
import type { Part, ToolResultPart } from '@/shared/parts'
import type { ContextModel, MeasuredStep, StepInput, TurnInput } from '@/server/plugins/context-manager'
import type { ContextProjection } from '@/server/plugins/hub/checkpoint'
import {
  attachmentsTokens, messagesTokens, MESSAGE_OVERHEAD_TOKENS, partTokens, textTokens, toolResultTextTokens,
  type AttachmentInfos,
} from './estimate'

/** Windows this large are rarely filled by accident, so they compact later (spec §3.2). */
const LARGE_WINDOW = 300_000

/** Where automatic compaction begins; null without a known context window, which means never. */
export function triggerLine(contextLimit: number | null): number | null {
  if (contextLimit === null || contextLimit <= 0) return null
  return Math.floor(contextLimit * (contextLimit < LARGE_WINDOW ? 0.8 : 0.9))
}

/** What the next request carries on top of a path: a step's results, files and interjections. */
export interface PendingInput {
  toolResults?: readonly ToolResultPart[]
  /** Files tools delivered that no request carried yet; the tool results' own attachments are these. */
  pendingAttachments?: readonly number[]
  pendingInterjections?: readonly Part[]
}

export function pendingOf(input: TurnInput | StepInput): PendingInput {
  return 'steps' in input
    ? { toolResults: input.toolResults, pendingAttachments: input.pendingAttachments, pendingInterjections: input.pendingInterjections }
    : {}
}

/** Every attachment an estimate of `projection` plus `pending` has to know the size of. */
export function estimateAttachmentIds(projection: ContextProjection, pending: PendingInput): number[] {
  const ids = new Set<number>()
  const add = (list: readonly number[] | undefined) => list?.forEach(id => ids.add(id))
  for (const message of projection.visible) {
    for (const part of message.parts) {
      if (part.type === 'image' || part.type === 'file') ids.add(part.attachment_id)
      else if (part.type === 'tool_result' || part.type === 'task_notification') add(part.attachments)
    }
  }
  add(projection.checkpoint?.attachments)
  add(pending.pendingAttachments)
  for (const part of pending.pendingInterjections ?? []) {
    if (part.type === 'image' || part.type === 'file') ids.add(part.attachment_id)
    else if (part.type === 'task_notification') add(part.attachments)
  }
  return [...ids]
}

/**
 * Tool results at the end of a measured reply. The request that reply's last step measured went out
 * before them, so the next request carries them as new.
 */
function trailingToolResults(message: Message, infos: AttachmentInfos): number {
  let total = 0
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const part = message.parts[index]!
    if (part.type !== 'tool_result') break
    total += partTokens(part, infos)
  }
  return total
}

function pendingTokens(pending: PendingInput, infos: AttachmentInfos): number {
  let total = 0
  for (const result of pending.toolResults ?? []) total += toolResultTextTokens(result)
  total += attachmentsTokens(pending.pendingAttachments ?? [], infos)
  const said = pending.pendingInterjections ?? []
  if (said.length > 0) total += MESSAGE_OVERHEAD_TOKENS + said.reduce((sum, part) => sum + partTokens(part, infos), 0)
  return total
}

/** The whole request estimated from its contents: the checkpoint's content, then what follows it. */
export function estimateWhole(projection: ContextProjection, infos: AttachmentInfos): number {
  const checkpoint = projection.checkpoint
  const opening = checkpoint
    ? MESSAGE_OVERHEAD_TOKENS + textTokens(checkpoint.content) + attachmentsTokens(checkpoint.attachments, infos)
    : 0
  return opening + messagesTokens(projection.visible, infos)
}

/**
 * The next request's input, estimated (spec §3.2): the last measured request — its input, cached part
 * included, plus its output, which the next request carries — then everything added since. Without a
 * usable measurement the whole request is estimated from its contents.
 */
export function estimateNextRequest(
  input: { projection: ContextProjection, lastStep: MeasuredStep | null },
  pending: PendingInput,
  infos: AttachmentInfos,
): number {
  const { projection, lastStep } = input
  const prompt = lastStep?.usage.prompt
  // The AI SDK's `inputTokens` is the total, cache reads and writes included.
  if (lastStep && prompt !== undefined && prompt > 0) {
    let total = prompt + (lastStep.usage.completion ?? 0)
    const index = projection.visible.findIndex(message => message.id === lastStep.messageId)
    if (index >= 0) {
      total += trailingToolResults(projection.visible[index]!, infos)
      total += messagesTokens(projection.visible.slice(index + 1), infos)
    }
    return total + pendingTokens(pending, infos)
  }
  return estimateWhole(projection, infos) + pendingTokens(pending, infos)
}

/** The first request recorded after the latest checkpoint, and the model it went to. */
function firstMeasuredAfterCheckpoint(visible: readonly Message[]): { prompt: number | undefined, providerId: number | null, modelId: string | null } | null {
  for (const message of visible) {
    if (message.role !== 'assistant' || !message.usage) continue
    const prompt = message.usage.steps?.[0]?.prompt ?? message.usage.prompt
    if (prompt === undefined) continue
    return { prompt, providerId: message.provider_id, modelId: message.model_id }
  }
  return null
}

/**
 * "Compacting did not help" (spec §3.2): the first real request after the latest checkpoint was still
 * at or over the trigger line, on the model in use now. Derived from the path every time, so a new
 * checkpoint or another model clears it without anything being stored.
 */
export function isIneffective(input: TurnInput | StepInput, line: number): boolean {
  if (!input.projection.checkpoint) return false
  const first = firstMeasuredAfterCheckpoint(input.projection.visible)
  if (first) {
    if (!sameModel(input.model, first.providerId, first.modelId)) return false
    return (first.prompt ?? 0) >= line
  }
  // Nothing on the path measured yet: this run's own first request is the first after the checkpoint.
  if ('steps' in input) {
    const prompt = input.steps[0]?.prompt
    return prompt !== undefined && prompt >= line
  }
  return false
}

function sameModel(model: ContextModel, providerId: number | null, modelId: string | null): boolean {
  return model.providerId === providerId && model.modelId === modelId
}

/** The message on the path that the ineffective state belongs to, for telling the person only once. */
export function checkpointMessageId(projection: ContextProjection): number | null {
  return projection.checkpointIndex === null ? null : projection.path[projection.checkpointIndex]!.id
}
