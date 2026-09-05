import type { TextStreamPart, ToolSet } from 'ai'
import type { Part, ProviderOptions, ReasoningPart, TextPart } from '@/shared/parts'

export type AccEvent =
  | { kind: 'delta'; part_index: number; part_kind: 'text' | 'reasoning'; delta: string }
  | { kind: 'part'; part_index: number; part: Part }

/**
 * Folds AI SDK stream parts into our Part[] while emitting broadcastable events.
 * One stream `id` maps to one part; consecutive deltas append; type changes open a new part.
 * Provider metadata on reasoning parts: last non-null wins (signatures arrive at the end).
 */
export class PartAccumulator {
  readonly parts: Part[] = []
  private readonly _indexById = new Map<string, number>()

  apply(part: TextStreamPart<ToolSet>): AccEvent[] {
    switch (part.type) {
      case 'text-start':
        this._open(part.id, { type: 'text', text: '' })
        return []
      case 'text-delta': {
        const idx = this._ensure(part.id, { type: 'text', text: '' })
        ;(this.parts[idx] as TextPart).text += part.text
        return [{ kind: 'delta', part_index: idx, part_kind: 'text', delta: part.text }]
      }
      case 'reasoning-start': {
        const idx = this._open(part.id, { type: 'reasoning', text: '' })
        this._mergeMeta(idx, part.providerMetadata)
        return []
      }
      case 'reasoning-delta': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        ;(this.parts[idx] as ReasoningPart).text += part.text
        this._mergeMeta(idx, part.providerMetadata)
        return part.text.length > 0 ? [{ kind: 'delta', part_index: idx, part_kind: 'reasoning', delta: part.text }] : []
      }
      case 'reasoning-end': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        this._mergeMeta(idx, part.providerMetadata)
        return []
      }
      case 'tool-call': {
        const p: Part = { type: 'tool_call', id: part.toolCallId, name: part.toolName, args: part.input }
        this.parts.push(p)
        return [{ kind: 'part', part_index: this.parts.length - 1, part: p }]
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

  private _mergeMeta(idx: number, meta: unknown): void {
    if (!meta) return
    const p = this.parts[idx] as ReasoningPart
    p.providerOptions = meta as ProviderOptions
  }
}
