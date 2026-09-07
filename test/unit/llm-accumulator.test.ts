import { describe, expect, it } from 'vitest'
import { PartAccumulator } from '@/server/plugins/llm/accumulator'

describe('PartAccumulator', () => {
  it('builds reasoning then text parts with indexes and keeps the last provider metadata', () => {
    const acc = new PartAccumulator()
    const events = [
      ...acc.apply({ type: 'reasoning-start', id: 'r1' }),
      ...acc.apply({ type: 'reasoning-delta', id: 'r1', text: 'thi' }),
      ...acc.apply({ type: 'reasoning-delta', id: 'r1', text: 'nk', providerMetadata: { anthropic: { signature: 'SIG' } } }),
      ...acc.apply({ type: 'reasoning-end', id: 'r1' }),
      ...acc.apply({ type: 'text-start', id: 't1' }),
      ...acc.apply({ type: 'text-delta', id: 't1', text: 'Hel' }),
      ...acc.apply({ type: 'text-delta', id: 't1', text: 'lo' }),
      ...acc.apply({ type: 'text-end', id: 't1' }),
    ]
    expect(events.filter(event => event.kind === 'delta')).toEqual([
      { kind: 'delta', part_index: 0, part_kind: 'reasoning', delta: 'thi' },
      { kind: 'delta', part_index: 0, part_kind: 'reasoning', delta: 'nk' },
      { kind: 'delta', part_index: 1, part_kind: 'text', delta: 'Hel' },
      { kind: 'delta', part_index: 1, part_kind: 'text', delta: 'lo' },
    ])
    expect(acc.parts).toEqual([
      { type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 'SIG' } } },
      { type: 'text', text: 'Hello' },
    ])
  })

  it('opens a part when a delta arrives without a start', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'text-delta', id: 'x', text: 'a' })
    expect(acc.parts).toEqual([{ type: 'text', text: 'a' }])
  })

  it('opens a new part when the same stream id changes kind', () => {
    const acc = new PartAccumulator()
    const events = [
      ...acc.apply({ type: 'reasoning-delta', id: 'same', text: 'why' }),
      ...acc.apply({ type: 'text-delta', id: 'same', text: 'because' }),
    ]
    expect(events).toEqual([
      { kind: 'delta', part_index: 0, part_kind: 'reasoning', delta: 'why' },
      { kind: 'delta', part_index: 1, part_kind: 'text', delta: 'because' },
    ])
    expect(acc.parts).toEqual([
      { type: 'reasoning', text: 'why' },
      { type: 'text', text: 'because' },
    ])
  })

  it('routes late deltas and metadata to the original part when two kinds share an id', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'reasoning-start', id: 'shared', providerMetadata: { responses: { itemId: 'rs_1' } } })
    acc.apply({ type: 'reasoning-delta', id: 'shared', text: 'first' })
    acc.apply({ type: 'text-start', id: 'shared' })
    acc.apply({ type: 'text-delta', id: 'shared', text: 'answer' })
    acc.apply({ type: 'reasoning-delta', id: 'shared', text: ' last', providerMetadata: { responses: { signature: 'SIG' } } })
    acc.apply({ type: 'reasoning-end', id: 'shared', providerMetadata: { responses: { reasoningEncryptedContent: 'ENC' } } })
    expect(acc.parts).toEqual([
      { type: 'reasoning', text: 'first last', providerOptions: { responses: { itemId: 'rs_1', signature: 'SIG', reasoningEncryptedContent: 'ENC' } } },
      { type: 'text', text: 'answer' },
    ])
  })

  it('keeps tools in their original stream position and retains metadata from each stage', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'tool-input-start', id: 'c1', toolName: 'lookup', providerMetadata: { responses: { itemId: 'fc_1' } } })
    acc.apply({ type: 'tool-input-delta', id: 'c1', delta: '{"q":', providerMetadata: { responses: { signature: 'SIG' } } })
    acc.apply({ type: 'text-delta', id: 't1', text: 'after tool' })
    acc.apply({ type: 'tool-input-end', id: 'c1', providerMetadata: { responses: { opaque: { state: ['A', null, 0] } } } })
    acc.apply({ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { q: 1 } } as never)
    expect(acc.parts).toEqual([
      { type: 'tool_call', id: 'c1', name: 'lookup', args: { q: 1 }, providerOptions: { responses: { itemId: 'fc_1', signature: 'SIG', opaque: { state: ['A', null, 0] } } } },
      { type: 'text', text: 'after tool' },
    ])
  })

  it('starts fresh id bindings at the next model step', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'text-delta', id: 'reused', text: 'first' })
    acc.apply({ type: 'start-step', request: {}, warnings: [] })
    acc.apply({ type: 'text-delta', id: 'reused', text: 'second' })
    expect(acc.parts).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }])
  })

  it('preserves a tool result and its opaque metadata before subsequent reasoning', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', input: {}, output: { ok: true }, providerMetadata: { responses: { opaque: ['state', null, 0] } } } as never)
    acc.apply({ type: 'reasoning-delta', id: 'r2', text: 'next' })
    expect(acc.parts).toEqual([
      { type: 'tool_result', call_id: 'c1', name: 'lookup', content: { ok: true }, providerOptions: { responses: { opaque: ['state', null, 0] } } },
      { type: 'reasoning', text: 'next' },
    ])
  })

  it('emits a full part for tool calls', () => {
    const acc = new PartAccumulator()
    const ev = acc.apply({ type: 'tool-call', toolCallId: 'c1', toolName: 'f', input: { a: 1 } } as never)
    expect(ev).toEqual([{ kind: 'part', part_index: 0, part: { type: 'tool_call', id: 'c1', name: 'f', args: { a: 1 } } }])
  })

  it('keeps provider metadata on text and tool-call parts', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'text-start', id: 't1' })
    acc.apply({ type: 'text-delta', id: 't1', text: 'hi' })
    // Gemini attaches the thought signature to the closing event of the block it belongs to.
    acc.apply({ type: 'text-end', id: 't1', providerMetadata: { google: { thoughtSignature: 'TS_TEXT' } } })
    const ev = acc.apply({ type: 'tool-call', toolCallId: 'c1', toolName: 'f', input: { a: 1 }, providerMetadata: { google: { thoughtSignature: 'TS_TOOL' } } } as never)
    expect(ev).toEqual([{
      kind: 'part',
      part_index: 1,
      part: { type: 'tool_call', id: 'c1', name: 'f', args: { a: 1 }, providerOptions: { google: { thoughtSignature: 'TS_TOOL' } } },
    }])
    expect(acc.parts).toEqual([
      { type: 'text', text: 'hi', providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } },
      { type: 'tool_call', id: 'c1', name: 'f', args: { a: 1 }, providerOptions: { google: { thoughtSignature: 'TS_TOOL' } } },
    ])
  })

  it('keeps an empty reasoning summary that only carries encrypted metadata', () => {
    const acc = new PartAccumulator()
    // OpenAI Responses with `store: false`: no visible summary, but an item id and encrypted content.
    acc.apply({ type: 'reasoning-start', id: 'r1', providerMetadata: { openai: { itemId: 'rs_1' } } })
    acc.apply({ type: 'reasoning-end', id: 'r1', providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } })
    expect(acc.parts).toEqual([
      { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
    ])
  })

  it('emits metadata-only reasoning and closing updates so live clients match persisted parts', () => {
    const acc = new PartAccumulator()
    const started = acc.apply({ type: 'reasoning-start', id: 'r1', providerMetadata: { responses: { itemId: 'r1' } } })
    const ended = acc.apply({ type: 'reasoning-end', id: 'r1', providerMetadata: { responses: { reasoningEncryptedContent: 'ENC' } } })
    expect(started).toEqual([{ kind: 'part', part_index: 0, part: { type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'r1' } } } }])
    expect(ended).toEqual([{ kind: 'part', part_index: 0, part: { type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'r1', reasoningEncryptedContent: 'ENC' } } } }])
  })

  it('never lets a later event without metadata clear what was already captured', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'reasoning-start', id: 'r1' })
    acc.apply({ type: 'reasoning-delta', id: 'r1', text: 'why', providerMetadata: { anthropic: { signature: 'SIG' } } })
    acc.apply({ type: 'reasoning-end', id: 'r1' })
    acc.apply({ type: 'text-start', id: 't1' })
    acc.apply({ type: 'text-delta', id: 't1', text: 'because', providerMetadata: { google: { thoughtSignature: 'TS' } } })
    acc.apply({ type: 'text-end', id: 't1' })
    expect(acc.parts).toEqual([
      { type: 'reasoning', text: 'why', providerOptions: { anthropic: { signature: 'SIG' } } },
      { type: 'text', text: 'because', providerOptions: { google: { thoughtSignature: 'TS' } } },
    ])
  })

  it('appends an already-persisted part without giving it a stream id', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'text-start', id: 't1' })
    acc.apply({ type: 'text-delta', id: 't1', text: 'here: ' })
    // A generated image reaches the accumulator only after it is an attachment id (spec §5.8).
    const ev = acc.append({ type: 'image', attachment_id: 7 })
    expect(ev).toEqual({ kind: 'part', part_index: 1, part: { type: 'image', attachment_id: 7 } })
    // The open text block keeps its own index; nothing can reopen the image part.
    acc.apply({ type: 'text-delta', id: 't1', text: 'done' })
    expect(acc.parts).toEqual([
      { type: 'text', text: 'here: done' },
      { type: 'image', attachment_id: 7 },
    ])
  })

  it('ignores lifecycle parts', () => {
    const acc = new PartAccumulator()
    expect(acc.apply({ type: 'start' })).toEqual([])
    expect(acc.apply({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: { inputTokens: 1, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined }, outputTokens: 1, outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }, totalTokens: 2 } })).toEqual([])
  })
})
