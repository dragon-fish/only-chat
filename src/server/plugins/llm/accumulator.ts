import type { TextStreamPart, ToolSet } from 'ai'
import type { Part, ProviderOptions, ReasoningPart, TextPart, ToolCallPart } from '@/shared/parts'

export type AccEvent =
  | { kind: 'delta'; part_index: number; part_kind: 'text' | 'reasoning'; delta: string }
  | { kind: 'part'; part_index: number; part: Part }

/** The part kinds that carry provider metadata; images and tool results never do. */
type MetaPart = TextPart | ReasoningPart | ToolCallPart

/**
 * Folds AI SDK stream parts into our Part[] while emitting broadcastable events.
 * One stream `id` maps to one part; consecutive deltas append; type changes open a new part.
 * Provider metadata on text, reasoning and tool-call parts: the last non-null one wins, because
 * signatures and encrypted content arrive on the closing event of the block they belong to.
 */
export class PartAccumulator {
  readonly parts: Part[] = []
  private readonly _indexById = new Map<string, number>()

  apply(part: TextStreamPart<ToolSet>): AccEvent[] {
    switch (part.type) {
      case 'text-start': {
        const idx = this._open(part.id, { type: 'text', text: '' })
        this._setMeta(idx, part.providerMetadata)
        return []
      }
      case 'text-delta': {
        const idx = this._ensure(part.id, { type: 'text', text: '' })
        ;(this.parts[idx] as TextPart).text += part.text
        this._setMeta(idx, part.providerMetadata)
        return [{ kind: 'delta', part_index: idx, part_kind: 'text', delta: part.text }]
      }
      case 'text-end': {
        const idx = this._ensure(part.id, { type: 'text', text: '' })
        this._setMeta(idx, part.providerMetadata)
        return []
      }
      case 'reasoning-start': {
        const idx = this._open(part.id, { type: 'reasoning', text: '' })
        this._setMeta(idx, part.providerMetadata)
        return []
      }
      case 'reasoning-delta': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        ;(this.parts[idx] as ReasoningPart).text += part.text
        this._setMeta(idx, part.providerMetadata)
        return part.text.length > 0 ? [{ kind: 'delta', part_index: idx, part_kind: 'reasoning', delta: part.text }] : []
      }
      case 'reasoning-end': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        this._setMeta(idx, part.providerMetadata)
        return []
      }
      case 'tool-call': {
        const p: Part = { type: 'tool_call', id: part.toolCallId, name: part.toolName, args: part.input }
        this.parts.push(p)
        const idx = this.parts.length - 1
        this._setMeta(idx, part.providerMetadata)
        return [{ kind: 'part', part_index: idx, part: p }]
      }
      default:
        return []
    }
  }

  private _open(id: string, part: Part): number {
    this.parts.push(part)
    const idx = this.parts.length - 1
    this._indexById.set(id, idx)
    return idx
  }

  /** Reuses the part this id already owns, but a kind change always opens a new part. */
  private _ensure(id: string, part: Part): number {
    const idx = this._indexById.get(id)
    if (idx !== undefined && this.parts[idx]!.type === part.type) return idx
    return this._open(id, part)
  }

  /** Stored verbatim: encrypted reasoning and signatures are never parsed, merged or rewritten. */
  private _setMeta(idx: number, meta: unknown): void {
    if (!meta) return
    ;(this.parts[idx] as MetaPart).providerOptions = meta as ProviderOptions
  }
}
