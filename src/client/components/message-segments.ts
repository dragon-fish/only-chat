import type { ImagePart, Part, ToolCallPart, ToolResultPart } from '@/shared/parts'

export type MessageSegment =
  | { kind: 'reasoning'; key: string; text: string }
  | { kind: 'text'; key: string; markdown: string }
  | { kind: 'tool'; key: string; call: ToolCallPart; result: ToolResultPart | null }
  | { kind: 'image'; key: string; part: ImagePart }

/**
 * `parts` is already in the order the model produced it — the accumulator gives every kind/id pair
 * a fixed position for the whole step. Rendering it by walking that order is what puts a tool card
 * between the thought that led to it and the thought that followed.
 *
 * Grouping by type instead (all reasoning, then the answer, then every tool card) silently rebuilt
 * the turn into something that never happened, which only looked harmless while a turn held at most
 * one tool call at the very end.
 *
 * Adjacent parts of the same kind merge: one answer must stay one markdown document, or headings
 * and lists split across renderers mid-structure.
 */
export function messageSegments(parts: readonly Part[]): MessageSegment[] {
  const segments: MessageSegment[] = []
  const toolIndex = new Map<string, number>()

  for (const [index, part] of parts.entries()) {
    switch (part.type) {
      case 'text': {
        if (part.text === '') break
        const last = segments.at(-1)
        if (last?.kind === 'text') last.markdown += part.text
        else segments.push({ kind: 'text', key: `text:${index}`, markdown: part.text })
        break
      }
      case 'reasoning': {
        if (part.text.trim() === '') break
        const last = segments.at(-1)
        if (last?.kind === 'reasoning') last.text += `\n${part.text}`
        else segments.push({ kind: 'reasoning', key: `reasoning:${index}`, text: part.text })
        break
      }
      case 'tool_call': {
        toolIndex.set(part.id, segments.length)
        segments.push({ kind: 'tool', key: `tool:${part.id}`, call: part, result: null })
        break
      }
      case 'tool_result': {
        // Results carry no position of their own; they belong to the card their call already owns.
        const at = toolIndex.get(part.call_id)
        const segment = at === undefined ? undefined : segments[at]
        if (segment?.kind === 'tool') segment.result = part
        break
      }
      case 'image': {
        segments.push({ kind: 'image', key: `image:${index}`, part })
        break
      }
    }
  }
  return segments
}
