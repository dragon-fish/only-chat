import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamText, wrapLanguageModel, type TextStreamPart, type ToolSet } from 'ai'
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { PartAccumulator } from '@/server/plugins/llm/accumulator'
import { coalescingStream, deltaCoalescing } from '@/server/plugins/llm/delta-coalesce'
import { responsesAdapter } from '@/server/plugins/llm/protocols/responses'
import { deepseekReasoningItem, deepseekResponsesStream } from '../fixtures/deepseek-responses-stream'

type P = LanguageModelV4StreamPart

async function coalesced(parts: P[]): Promise<P[]> {
  const stream = new ReadableStream<P>({ start(c) { parts.forEach(p => c.enqueue(p)); c.close() } }).pipeThrough(coalescingStream(60_000))
  const out: P[] = []
  for await (const part of stream as unknown as AsyncIterable<P>) out.push(part)
  return out
}

const text = (id: string, delta: string): P => ({ type: 'text-delta', id, delta })
const thought = (id: string, delta: string): P => ({ type: 'reasoning-delta', id, delta })
const raw = (type: string, delta: string, sequence_number: number, extra: Record<string, unknown> = {}): P => ({
  type: 'raw', rawValue: { type, item_id: 'rs_1', output_index: 0, ...extra, delta, sequence_number },
})
const FULL = 'response.reasoning_text.delta'
const SUMMARY = 'response.reasoning_summary_text.delta'

function untimed(value: unknown): any {
  if (Array.isArray(value)) return value.map(untimed)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'duration_ms').map(([key, entry]) => [key, untimed(entry)]))
}

/** The DeepSeek fixture, or a longer stream of the same shape with many one-token deltas. */
function longDeepseekStream(): Response {
  const full = ['我', '们', '需要', ' ', 'x', '。'], summary = ['sum', 'mary'], answer = ['Hel', 'lo', '!']
  const item = { ...deepseekReasoningItem, summary: [{ type: 'summary_text', text: summary.join('') }], content: [{ type: 'reasoning_text', text: full.join('') }] }
  const message = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: answer.join(''), annotations: [] }] }
  const response = { id: 'resp_1', object: 'response', status: 'completed', error: null, incomplete_details: null, output: [item, message], usage: { input_tokens: 1, output_tokens: 11 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { id: item.id, type: 'reasoning', status: 'in_progress', summary: [] } },
    ...summary.map(delta => ({ type: SUMMARY, output_index: 0, item_id: item.id, summary_index: 0, delta })),
    ...full.map(delta => ({ type: FULL, output_index: 0, item_id: item.id, content_index: 0, delta })),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.output_item.added', output_index: 1, item: { ...message, status: 'in_progress', content: [] } },
    ...answer.map(delta => ({ type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', content_index: 0, delta })),
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response },
  ]
  return new Response(events.map((e, sequence_number) => `data: ${JSON.stringify({ ...e, sequence_number })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

/** The production path: open-responses parsing the body, raw chunks on, into the accumulator. */
async function accumulate(body: () => Response, coalesce: boolean) {
  vi.stubGlobal('fetch', async () => body())
  const base = responsesAdapter.createModel({ id: 1 } as never, { id: 1, base_url: 'https://api.deepseek.com' } as never, { model_id: 'm' } as never, { apiKey: 'k', headers: {} }) as LanguageModelV4
  const result = streamText({
    model: coalesce ? wrapLanguageModel({ model: base, middleware: deltaCoalescing }) : base,
    prompt: 'hi',
    include: { rawChunks: true },
  })
  const acc = new PartAccumulator()
  // What a client rebuilds from the broadcast: a part event replaces, a delta appends.
  const client: Record<string, unknown>[] = []
  let deltas = 0
  for await (const part of result.stream as AsyncIterable<TextStreamPart<ToolSet>>) {
    for (const ev of acc.apply(part)) {
      if (ev.kind === 'part') client[ev.part_index] = { ...ev.part }
      else { deltas++; client[ev.part_index]!.text = `${client[ev.part_index]!.text}${ev.delta}` }
    }
  }
  return { parts: untimed(acc.parts), client: untimed(client), deltas }
}

describe('deltaCoalescing', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('merges only consecutive deltas of one kind and id, and keeps every other part in place', async () => {
    const start: P = { type: 'tool-input-start', id: 'c1', toolName: 'lookup' }
    const finish: P = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } } }
    expect(await coalesced([
      text('t1', 'a'), text('t1', 'b'), thought('t1', 'c'), thought('t1', 'd'), text('t2', 'e'), text('t1', 'f'),
      start, { type: 'tool-input-delta', id: 'c1', delta: '{"q"' }, { type: 'tool-input-delta', id: 'c1', delta: ':1}' },
      { type: 'tool-input-delta', id: 'c2', delta: '{}' }, text('t1', 'g'), text('t1', 'h'), finish,
    ])).toEqual([
      text('t1', 'ab'), thought('t1', 'cd'), text('t2', 'e'), text('t1', 'f'),
      start, { type: 'tool-input-delta', id: 'c1', delta: '{"q":1}' },
      { type: 'tool-input-delta', id: 'c2', delta: '{}' }, text('t1', 'gh'), finish,
    ])
  })

  it('never merges a delta that carries provider metadata', async () => {
    const signature: P = { type: 'reasoning-delta', id: '0', delta: '', providerMetadata: { anthropic: { signature: 'SIG' } } }
    const annotated: P = { type: 'text-delta', id: '1', delta: 'x', providerMetadata: { p: { a: 1 } } }
    expect(await coalesced([thought('0', 'thi'), thought('0', 'nk'), signature, signature, thought('0', 'more'), annotated, text('1', 'y'), text('1', 'z')]))
      .toEqual([thought('0', 'think'), signature, signature, thought('0', 'more'), annotated, text('1', 'yz')])
  })

  it('joins a run of raw Responses deltas into one raw part right before the merged delta', async () => {
    const done: P = { type: 'raw', rawValue: { type: 'response.output_item.done', item: { id: 'rs_1' } } }
    expect(await coalesced([
      raw(SUMMARY, 'S', 1, { summary_index: 0 }), thought('rs_1', 'S'),
      raw(FULL, 'a', 2, { content_index: 0 }), thought('rs_1', 'a'),
      raw(FULL, 'b', 3, { content_index: 0 }), thought('rs_1', 'b'),
      raw(FULL, 'c', 4, { content_index: 1 }), thought('rs_1', 'c'),
      done,
      raw(FULL, 'd', 5, { content_index: 1 }), thought('rs_1', 'd'),
    ])).toEqual([
      raw(SUMMARY, 'S', 1, { summary_index: 0 }), thought('rs_1', 'S'),
      raw(FULL, 'ab', 3, { content_index: 0 }), thought('rs_1', 'ab'),
      raw(FULL, 'c', 4, { content_index: 1 }), thought('rs_1', 'c'),
      done,
      raw(FULL, 'd', 5, { content_index: 1 }), thought('rs_1', 'd'),
    ])
  })

  // Without completed content the stored reasoning is rebuilt from the raw deltas alone.
  it.each([
    ['the DeepSeek fixture', () => deepseekResponsesStream()],
    ['the DeepSeek fixture without completed content', () => deepseekResponsesStream({ omitReasoningContent: true })],
    ['a long DeepSeek-shaped stream', longDeepseekStream],
  ])(
    'leaves the stored and the broadcast reply of %s unchanged while sending fewer deltas',
    async (_name, body) => {
      const plain = await accumulate(body, false)
      const merged = await accumulate(body, true)
      expect(merged.parts).toEqual(plain.parts)
      expect(merged.client).toEqual(plain.client)
      expect(merged.deltas).toBeLessThan(plain.deltas)
    },
  )

  it('passes a held run on once the window ends, without waiting for the next part', async () => {
    vi.useFakeTimers()
    let close!: () => void
    const source = new ReadableStream<P>({ start(c) { c.enqueue(text('t', 'tail')); close = () => c.close() } })
    const reader = source.pipeThrough(coalescingStream(50)).getReader()
    const next = reader.read()
    await vi.advanceTimersByTimeAsync(60)
    await expect(next).resolves.toEqual({ done: false, value: text('t', 'tail') })
    close()
  })
})
