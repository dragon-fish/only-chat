import type { TextStreamPart, ToolSet } from 'ai'
import { getErrorMessage } from '@ai-sdk/provider'
import { toolResultPart, type Part, type ProviderOptions, type ReasoningPart, type TextPart, type ToolCallPart, type ToolResultPart } from '@/shared/parts'
import {
  completedResponsesReasoningOptions, completedResponsesReasoningText, readResponsesReasoningDelta,
  streamedResponsesReasoningOptions, type ResponsesReasoningBuffers, type ResponsesReasoningDelta,
} from './responses-reasoning'

export type AccEvent =
  | { kind: 'delta'; part_index: number; part_kind: 'text' | 'reasoning'; delta: string }
  | { kind: 'part'; part_index: number; part: Part }

/** The half of `AccEvent` that carries a whole part, which is all `append` can ever produce. */
export type AccPartEvent = Extract<AccEvent, { kind: 'part' }>

type MetaPart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart

/**
 * Folds AI SDK stream parts into our Part[] while emitting broadcastable events.
 * Each kind/id pair owns its original position for the whole model step. Metadata fields from
 * start, delta and end are retained; a later value replaces that field without interpreting it.
 */
export class PartAccumulator {
  readonly parts: Part[] = []
  private readonly _indexById = new Map<string, number>()
  private readonly _pendingResponsesDeltas: ResponsesReasoningDelta[] = []
  private readonly _responsesById = new Map<string, ResponsesReasoningBuffers>()
  /** Opened at the first sign of a reasoning block, read once when it closes. */
  private readonly _reasoningStartedAt = new Map<string, number>()

  apply(part: TextStreamPart<ToolSet>): AccEvent[] {
    switch (part.type) {
      case 'start-step':
        this._indexById.clear()
        this._pendingResponsesDeltas.length = 0
        this._responsesById.clear()
        return []
      case 'raw': {
        const delta = readResponsesReasoningDelta(part.rawValue)
        if (delta) this._pendingResponsesDeltas.push(delta)
        return []
      }
      case 'text-start': {
        const idx = this._ensure(part.id, { type: 'text', text: '' })
        this._setMeta(idx, part.providerMetadata)
        return [this._partEvent(idx)]
      }
      case 'text-delta': {
        const idx = this._ensure(part.id, { type: 'text', text: '' })
        ;(this.parts[idx] as TextPart).text += part.text
        this._setMeta(idx, part.providerMetadata)
        const events: AccEvent[] = [{ kind: 'delta', part_index: idx, part_kind: 'text', delta: part.text }]
        if (part.providerMetadata) events.push(this._partEvent(idx))
        return events
      }
      case 'text-end': {
        const idx = this._ensure(part.id, { type: 'text', text: '' })
        this._setMeta(idx, part.providerMetadata)
        return [this._partEvent(idx)]
      }
      case 'reasoning-start': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        this._openReasoningClock(part.id)
        this._setMeta(idx, part.providerMetadata)
        return [this._partEvent(idx)]
      }
      case 'reasoning-delta': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        // Some providers stream deltas without ever sending `reasoning-start`.
        this._openReasoningClock(part.id)
        this._setMeta(idx, part.providerMetadata)
        const source = this._pendingResponsesDeltas.shift()
        if (source) {
          // Open Responses emits raw immediately before normalized delta; AI SDK may rename its ID.
          const buffer = this._responsesById.get(part.id) ?? { itemId: source.itemId }
          if (buffer.itemId !== source.itemId) throw new Error('Responses reasoning delta does not match its stream')
          const hadFull = buffer.full !== undefined
          const hadSummary = buffer.summary !== undefined
          buffer[source.kind] = (buffer[source.kind] ?? '') + source.text
          this._responsesById.set(part.id, buffer)
          this._setMeta(idx, streamedResponsesReasoningOptions(buffer))
          ;(this.parts[idx] as ReasoningPart).text = buffer.full ?? buffer.summary ?? ''
          if (source.kind === 'full' && !hadFull && hadSummary) return [this._partEvent(idx)]
          const events: AccEvent[] = source.text.length > 0 && (source.kind === 'full' || !hadFull)
            ? [{ kind: 'delta', part_index: idx, part_kind: 'reasoning', delta: source.text }] : []
          if (part.providerMetadata) events.push(this._partEvent(idx))
          return events
        }
        ;(this.parts[idx] as ReasoningPart).text += part.text
        const events: AccEvent[] = part.text.length > 0 ? [{ kind: 'delta', part_index: idx, part_kind: 'reasoning', delta: part.text }] : []
        if (part.providerMetadata) events.push(this._partEvent(idx))
        return events
      }
      case 'reasoning-end': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        this._setMeta(idx, part.providerMetadata)
        const reasoning = this.parts[idx] as ReasoningPart
        const buffer = this._responsesById.get(part.id)
        if (buffer) reasoning.providerOptions = completedResponsesReasoningOptions(reasoning.providerOptions, buffer)
        reasoning.text = completedResponsesReasoningText(reasoning.text, reasoning.providerOptions)
        const startedAt = this._reasoningStartedAt.get(part.id)
        if (startedAt !== undefined) reasoning.duration_ms = Math.max(0, Date.now() - startedAt)
        this._reasoningStartedAt.delete(part.id)
        this._responsesById.delete(part.id)
        return [this._partEvent(idx)]
      }
      case 'tool-input-start': {
        const idx = this._ensure(part.id, { type: 'tool_call', id: part.id, name: part.toolName, args: '' })
        this._setMeta(idx, part.providerMetadata)
        return [this._partEvent(idx)]
      }
      case 'tool-input-delta':
      case 'tool-input-end': {
        const idx = this._indexById.get(`tool_call:${part.id}`)
        if (idx === undefined) throw new Error('tool input received before its start')
        if (part.type === 'tool-input-delta') (this.parts[idx] as ToolCallPart).args += part.delta
        this._setMeta(idx, part.providerMetadata)
        // The start event already exposed one stable placeholder. Keep partial JSON and metadata
        // server-side until the SDK emits the validated tool call; broadcasting every delta makes
        // clients repeatedly parse and render knowingly incomplete input.
        return []
      }
      case 'tool-call': {
        const idx = this._ensure(part.toolCallId, { type: 'tool_call', id: part.toolCallId, name: part.toolName, args: part.input })
        const p = this.parts[idx] as ToolCallPart
        p.name = part.toolName
        p.args = part.input
        this._setMeta(idx, part.providerMetadata)
        return [this._partEvent(idx)]
      }
      case 'tool-result': {
        const result = toolResultPart(part.toolCallId, part.toolName, part.output)
        const idx = this._ensure(part.toolCallId, result)
        const target = this.parts[idx] as ToolResultPart
        target.content = result.content
        if (result.attachments) target.attachments = result.attachments
        this._setMeta(idx, part.providerMetadata)
        return [this._partEvent(idx)]
      }
      default:
        return []
    }
  }

  /**
   * Records a tool that failed instead of answering, with the text the SDK sent the model for it.
   * Not done for every `tool-error`: the SDK also emits one for a tool with no `execute` (answered
   * by a person later) and for an absent tool (answered as interrupted by the prompt builder), so
   * the caller decides which failures are real.
   */
  toolError(part: Extract<TextStreamPart<ToolSet>, { type: 'tool-error' }>): AccPartEvent {
    const content = getErrorMessage(part.error)
    const idx = this._ensure(part.toolCallId, { type: 'tool_result', call_id: part.toolCallId, name: part.toolName, content, is_error: true })
    const target = this.parts[idx] as ToolResultPart
    target.content = content
    target.is_error = true
    return this._partEvent(idx)
  }

  /**
   * Adds a part that never arrived as a stream delta — a generated image, already persisted to R2
   * and reduced to an `attachment_id`. It owns no stream id, so no later event can reopen it.
   */
  append(part: Part): AccPartEvent {
    this.parts.push(part)
    return { kind: 'part', part_index: this.parts.length - 1, part }
  }

  private _openReasoningClock(id: string): void {
    if (!this._reasoningStartedAt.has(id)) this._reasoningStartedAt.set(id, Date.now())
  }

  private _open(id: string, part: Part): number {
    this.parts.push(part)
    const idx = this.parts.length - 1
    this._indexById.set(`${part.type}:${id}`, idx)
    return idx
  }

  private _ensure(id: string, part: Part): number {
    const idx = this._indexById.get(`${part.type}:${id}`)
    if (idx !== undefined) return idx
    return this._open(id, part)
  }

  private _partEvent(idx: number): AccPartEvent {
    return { kind: 'part', part_index: idx, part: { ...this.parts[idx]! } }
  }

  /** Merge namespace fields only; signatures, arrays and nested opaque values remain verbatim. */
  private _setMeta(idx: number, meta: ProviderOptions | undefined): void {
    if (!meta) return
    const part = this.parts[idx] as MetaPart
    const next = { ...part.providerOptions }
    for (const [namespace, values] of Object.entries(meta)) next[namespace] = { ...next[namespace], ...values }
    part.providerOptions = next
  }
}
