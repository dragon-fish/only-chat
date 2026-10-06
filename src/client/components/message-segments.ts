import type { Usage } from '@/shared/models'
import type { CheckpointPart, ImagePart, Part, ToolCallPart, ToolResultPart } from '@/shared/parts'

export type MessageSegment =
  | {
    kind: 'reasoning'; key: string; text: string; durationMs: number | null
    /** The step's reported reasoning tokens; null when unreported, zero, or not attributable. */
    tokens: number | null
  }
  | { kind: 'text'; key: string; markdown: string }
  | { kind: 'tool'; key: string; call: ToolCallPart; result: ToolResultPart | null }
  | { kind: 'image'; key: string; part: ImagePart }
  /** A boundary, never folded or merged: text on either side of it is not one document. */
  | { kind: 'checkpoint'; key: string; part: CheckpointPart }

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
export function messageSegments(parts: readonly Part[], usage?: Usage | null): MessageSegment[] {
  const segments: MessageSegment[] = []
  const toolIndex = new Map<string, number>()
  // Round trip each reasoning segment belongs to: a step ends once its tool results are in.
  const reasoningStep = new Map<MessageSegment, number>()
  let step = 0
  let afterResult = false

  for (const [index, part] of parts.entries()) {
    if (afterResult && part.type !== 'tool_result') step++
    afterResult = part.type === 'tool_result'
    switch (part.type) {
      case 'text': {
        if (part.text === '') break
        const last = segments.at(-1)
        if (last?.kind === 'text') last.markdown += part.text
        else segments.push({ kind: 'text', key: `text:${index}`, markdown: part.text })
        break
      }
      case 'reasoning': {
        // An empty block is kept: providers that hide the thinking (encrypted, or summary-only with
        // an empty summary) still open and close one, and dropping it left a long silent wait.
        const text = part.text.trim() === '' ? '' : part.text
        const last = segments.at(-1)
        // Merged blocks add up: the reader sees one span of thinking, so it reports one duration.
        // Still null when no part in the run carries one — an unfinished block, or one from before
        // durations were recorded.
        if (last?.kind === 'reasoning') {
          if (text) last.text = last.text ? `${last.text}\n${text}` : text
          if (part.duration_ms !== undefined) last.durationMs = (last.durationMs ?? 0) + part.duration_ms
        }
        else {
          const segment: MessageSegment = {
            kind: 'reasoning',
            key: `reasoning:${index}`,
            text,
            durationMs: part.duration_ms ?? null,
            tokens: null,
          }
          segments.push(segment)
          reasoningStep.set(segment, step)
        }
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
      case 'checkpoint': {
        segments.push({ kind: 'checkpoint', key: `checkpoint:${index}`, part })
        break
      }
    }
  }
  // Answered tools are always followed by another request, even one that came back empty.
  attributeReasoningTokens(reasoningStep, step + (afterResult ? 2 : 1), usage)
  return segments
}

/**
 * Usage is reported per round trip, not per block, so a count is attached only where it cannot land
 * on the wrong block: the parts must split into exactly as many steps as were recorded, and the step
 * must hold one reasoning segment. Zero is left off — a proxy that hides the thinking reports zero.
 */
function attributeReasoningTokens(reasoningStep: Map<MessageSegment, number>, stepCount: number, usage?: Usage | null) {
  if (!usage) return
  const perStep = usage.steps ? usage.steps.map(s => s.reasoning) : [usage.reasoning]
  if (perStep.length !== stepCount) return
  const segmentsInStep = new Map<number, number>()
  for (const step of reasoningStep.values()) segmentsInStep.set(step, (segmentsInStep.get(step) ?? 0) + 1)
  for (const [segment, step] of reasoningStep) {
    const tokens = perStep[step]
    if (segment.kind !== 'reasoning' || segmentsInStep.get(step) !== 1 || !tokens) continue
    segment.tokens = tokens
  }
}

export type TurnBlock =
  /** Rendered as itself: speech, output, or a lone thought that already collapses on its own. */
  | { kind: 'segment'; key: string; segment: MessageSegment }
  /** A run of steps behind one summary, so step count stops driving message height. */
  | { kind: 'process'; key: string; segments: MessageSegment[] }

/**
 * Groups a turn for display. Consecutive thinking and tool calls fold into one collapsible; an
 * agent that calls twenty tools between two sentences costs one line, not twenty.
 *
 * Text is never folded away, even mid-chain. A model that reports progress before continuing is
 * talking to the reader, not thinking out loud, and hiding that turns a conversation into a log.
 *
 * A run holding a tool nobody has answered yet is not folded either: the reader is being asked to
 * act on it, and a collapsible pinned open is just a chevron that does nothing.
 */
export function turnBlocks(segments: readonly MessageSegment[]): TurnBlock[] {
  const blocks: TurnBlock[] = []
  let run: MessageSegment[] = []

  const flush = () => {
    if (run.length === 0) return
    const plain = hasPendingTool(run)
      // One thought is already a collapsible; wrapping it would show two identical headers.
      || (run.length === 1 && run[0]!.kind === 'reasoning')
      // Nor is one call a sequence. Folding it puts a chevron in front of the only thing in the
      // run — most often an ask_user the reader has just answered, or is about to read.
      || (run.length === 1 && run[0]!.kind === 'tool')
    if (plain) blocks.push(...run.map(segment => ({ kind: 'segment' as const, key: segment.key, segment })))
    else blocks.push({ kind: 'process', key: `process:${run[0]!.key}`, segments: run })
    run = []
  }

  for (const segment of segments) {
    if (segment.kind === 'reasoning' || segment.kind === 'tool') run.push(segment)
    else {
      flush()
      blocks.push({ kind: 'segment', key: segment.key, segment })
    }
  }
  flush()
  return blocks
}

/**
 * A tool the server cannot answer — `ask_user` waiting on a person. Its run stays unfolded, or the
 * reader is asked to respond to something they cannot see.
 */
export function hasPendingTool(segments: readonly MessageSegment[]): boolean {
  return segments.some(segment => segment.kind === 'tool' && segment.result === null)
}

/** Total thinking time across a run, or null when nothing in it was measured. */
export function totalReasoningMs(segments: readonly MessageSegment[]): number | null {
  let total: number | null = null
  for (const segment of segments) {
    if (segment.kind !== 'reasoning' || segment.durationMs === null) continue
    total = (total ?? 0) + segment.durationMs
  }
  return total
}
