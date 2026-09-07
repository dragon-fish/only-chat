import type { TextStreamPart, ToolSet } from 'ai'
import type { Part, ProviderOptions, ReasoningPart, TextPart, ToolCallPart, ToolResultPart } from '@/shared/parts'

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

  apply(part: TextStreamPart<ToolSet>): AccEvent[] {
    switch (part.type) {
      case 'start-step':
        this._indexById.clear()
        return []
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
        this._setMeta(idx, part.providerMetadata)
        return [this._partEvent(idx)]
      }
      case 'reasoning-delta': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        ;(this.parts[idx] as ReasoningPart).text += part.text
        this._setMeta(idx, part.providerMetadata)
        const events: AccEvent[] = part.text.length > 0 ? [{ kind: 'delta', part_index: idx, part_kind: 'reasoning', delta: part.text }] : []
        if (part.providerMetadata) events.push(this._partEvent(idx))
        return events
      }
      case 'reasoning-end': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        this._setMeta(idx, part.providerMetadata)
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
        return part.providerMetadata ? [this._partEvent(idx)] : []
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
        const idx = this._ensure(part.toolCallId, { type: 'tool_result', call_id: part.toolCallId, name: part.toolName, content: part.output })
        ;(this.parts[idx] as ToolResultPart).content = part.output
        this._setMeta(idx, part.providerMetadata)
        return [this._partEvent(idx)]
      }
      default:
        return []
    }
  }

  /**
   * Adds a part that never arrived as a stream delta — a generated image, already persisted to R2
   * and reduced to an `attachment_id`. It owns no stream id, so no later event can reopen it.
   */
  append(part: Part): AccPartEvent {
    this.parts.push(part)
    return { kind: 'part', part_index: this.parts.length - 1, part }
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
