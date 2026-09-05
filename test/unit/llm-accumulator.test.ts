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
    expect(events).toEqual([
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

  it('emits a full part for tool calls', () => {
    const acc = new PartAccumulator()
    const ev = acc.apply({ type: 'tool-call', toolCallId: 'c1', toolName: 'f', input: { a: 1 } } as never)
    expect(ev).toEqual([{ kind: 'part', part_index: 0, part: { type: 'tool_call', id: 'c1', name: 'f', args: { a: 1 } } }])
  })

  it('ignores lifecycle parts', () => {
    const acc = new PartAccumulator()
    expect(acc.apply({ type: 'start' })).toEqual([])
    expect(acc.apply({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: { inputTokens: 1, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined }, outputTokens: 1, outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }, totalTokens: 2 } })).toEqual([])
  })
})
