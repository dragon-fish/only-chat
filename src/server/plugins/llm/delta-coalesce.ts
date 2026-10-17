import type { LanguageModelMiddleware } from 'ai'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'

/** How long a run of deltas may be held back, counted from its first part. */
export const DELTA_COALESCE_MS = 50

type DeltaPart = Extract<LanguageModelV4StreamPart, { type: 'text-delta' | 'reasoning-delta' | 'tool-input-delta' }>
type RawDelta = Record<string, unknown> & { type: string; item_id: string; delta: string }

/**
 * Raw Open Responses events that the provider follows at once with their normalized delta
 * (`@ai-sdk/open-responses` 2.0.39 doStream enqueues the raw chunk, then the part, per event).
 */
const RAW_DELTA_TYPES = new Set(['response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.output_text.delta'])

function rawDelta(value: unknown): RawDelta | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string' || !RAW_DELTA_TYPES.has(event.type)) return undefined
  return typeof event.item_id === 'string' && typeof event.delta === 'string' ? event as RawDelta : undefined
}

/** Raw deltas of one run share everything that places them; only the text and sequence differ. */
function sameRawRun(a: RawDelta, b: RawDelta): boolean {
  return a.type === b.type && a.item_id === b.item_id && a.output_index === b.output_index
    && a.content_index === b.content_index && a.summary_index === b.summary_index
}

/**
 * Merges runs of consecutive deltas before they enter `streamText`.
 *
 * Every stream part pays a fixed CPU cost in each of the SDK's stream stages, then an accumulator
 * step and a WebSocket frame, regardless of its length. A provider that sends one token per event
 * (DeepSeek) costs many times more per token than one that sends several (Anthropic), enough to
 * exhaust the Durable Object's CPU budget on a long reply.
 *
 * Only same-kind, same-id deltas without provider metadata merge (a metadata delta such as
 * Anthropic's signature ends the run), within `DELTA_COALESCE_MS` of the run's first part; any
 * other part releases the run first, so order is kept. Usage arrives only on `finish`, which is
 * never merged.
 *
 * With `include.rawChunks`, Open Responses puts a raw event right before each normalized delta and
 * the accumulator pairs them by that order (`_pendingResponsesDeltas`). A run's raw events are
 * therefore merged too and re-emitted as one raw event, carrying the joined text, immediately before
 * the merged delta. Every other raw chunk passes through in place.
 */
export const deltaCoalescing: LanguageModelMiddleware = {
  async wrapStream({ doStream }) {
    const result = await doStream()
    return { ...result, stream: result.stream.pipeThrough(coalescingStream(DELTA_COALESCE_MS)) }
  },
}

export function coalescingStream(windowMs: number): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  let held: { part: DeltaPart; raw?: RawDelta; since: number } | undefined
  /** A raw delta waiting for the normalized part the provider emits right after it. */
  let rawAhead: RawDelta | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let out!: TransformStreamDefaultController<LanguageModelV4StreamPart>

  const release = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    if (!held) return
    const { part, raw } = held
    held = undefined
    if (raw) out.enqueue({ type: 'raw', rawValue: raw })
    out.enqueue(part)
  }
  const releaseRawAhead = () => {
    if (!rawAhead) return
    out.enqueue({ type: 'raw', rawValue: rawAhead })
    rawAhead = undefined
  }

  return new TransformStream({
    start(controller) { out = controller },
    transform(part) {
      const raw = part.type === 'raw' ? rawDelta(part.rawValue) : undefined
      if (raw) {
        releaseRawAhead()
        rawAhead = raw
        return
      }
      if ((part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-delta') && !part.providerMetadata) {
        const ownRaw = rawAhead
        rawAhead = undefined
        const run = held
        if (run && run.part.type === part.type && run.part.id === part.id && Date.now() - run.since < windowMs
          && (ownRaw ? run.raw !== undefined && sameRawRun(run.raw, ownRaw) : run.raw === undefined)) {
          run.part = { ...run.part, delta: run.part.delta + part.delta }
          if (ownRaw) run.raw = { ...ownRaw, delta: run.raw!.delta + ownRaw.delta }
          return
        }
        release()
        held = { part, raw: ownRaw, since: Date.now() }
        // Ends the run when the provider goes quiet, so the tail of a burst is never stranded.
        timer = setTimeout(() => {
          timer = undefined
          try { release() } catch { /* The stream already ended or was cancelled. */ }
        }, windowMs)
        return
      }
      release()
      releaseRawAhead()
      out.enqueue(part)
    },
    flush() {
      release()
      releaseRawAhead()
    },
  })
}
