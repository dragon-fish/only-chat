import { describe, expect, it } from 'vitest'
import { hasPendingTool, messageSegments, totalReasoningMs, turnBlocks } from '@/client/components/message-segments'
import type { Usage } from '@/shared/models'
import type { Part } from '@/shared/parts'

const text = (t: string): Part => ({ type: 'text', text: t })
const reasoning = (t: string, duration_ms?: number): Part => ({ type: 'reasoning', text: t, ...(duration_ms === undefined ? {} : { duration_ms }) })
const call = (id: string, name = 'web_search'): Part => ({ type: 'tool_call', id, name, args: {} })
const result = (id: string, name = 'web_search'): Part => ({ type: 'tool_result', call_id: id, name, content: {} })

describe('messageSegments', () => {
  it('keeps the order the model produced, so a tool card sits where it happened', () => {
    const parts = [
      reasoning('deciding'), call('a'), result('a'),
      reasoning('reading'), call('b'), result('b'),
      text('the answer'),
    ]
    expect(messageSegments(parts).map(s => s.kind)).toEqual([
      'reasoning', 'tool', 'reasoning', 'tool', 'text',
    ])
  })

  it('attaches each result to its own call and leaves an unanswered call pending', () => {
    const segments = messageSegments([call('a'), result('a'), call('b')])
    const tools = segments.filter(s => s.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]!.kind === 'tool' && tools[0]!.result).not.toBeNull()
    expect(tools[1]!.kind === 'tool' && tools[1]!.result).toBeNull()
  })

  it('merges adjacent text parts so one answer stays one markdown document', () => {
    const segments = messageSegments([text('# Title\n'), text('body'), call('a'), text('after')])
    expect(segments.map(s => s.kind)).toEqual(['text', 'tool', 'text'])
    expect(segments[0]!.kind === 'text' && segments[0]!.markdown).toBe('# Title\nbody')
  })

  it('merges adjacent reasoning parts but not across a tool call', () => {
    const segments = messageSegments([reasoning('one'), reasoning('two'), call('a'), reasoning('three')])
    expect(segments.map(s => s.kind)).toEqual(['reasoning', 'tool', 'reasoning'])
    expect(segments[0]!.kind === 'reasoning' && segments[0]!.text).toBe('one\ntwo')
  })

  it('drops empty text but keeps a reasoning block whose thinking the provider hid', () => {
    const segments = messageSegments([reasoning('  ', 1200), text(''), call('a')])
    expect(segments.map(s => s.kind)).toEqual(['reasoning', 'tool'])
    expect(segments[0]!.kind === 'reasoning' && segments[0]!.text).toBe('')
  })

  it('merges a hidden block into readable ones without a stray line break', () => {
    const segments = messageSegments([reasoning(''), reasoning('visible'), reasoning('')])
    expect(segments[0]!.kind === 'reasoning' && segments[0]!.text).toBe('visible')
  })

  it('gives each step its own reasoning tokens, counting the request that follows answered tools', () => {
    const tokens = (parts: Part[], usage: Usage) => messageSegments(parts, usage)
      .flatMap(s => (s.kind === 'reasoning' ? [s.tokens] : []))
    const parts = [reasoning(''), call('a'), result('a'), reasoning(''), call('b'), result('b')]
    const steps = (...reasoning: number[]): Usage => ({ steps: reasoning.map(r => ({ reasoning: r })) })

    expect(tokens(parts, steps(120, 0, 80))).toEqual([120, null])
    // A step count that does not line up with the parts attributes nothing rather than guessing.
    expect(tokens(parts, steps(120, 80))).toEqual([null, null])
    expect(tokens([reasoning(''), text('hi')], { reasoning: 42 })).toEqual([42])
  })

  it('attributes nothing when one step holds two reasoning blocks', () => {
    const segments = messageSegments([reasoning('a'), text('mid'), reasoning('b')], { reasoning: 90 })
    expect(segments.flatMap(s => (s.kind === 'reasoning' ? [s.tokens] : []))).toEqual([null, null])
  })

  it('gives every segment a key that survives a later part arriving', () => {
    const before = messageSegments([reasoning('one'), call('a')])
    const after = messageSegments([reasoning('one'), call('a'), result('a'), text('done')])
    expect(after.slice(0, 2).map(s => s.key)).toEqual(before.map(s => s.key))
  })

  it('adds up the durations of a merged run, and stays null when none were recorded', () => {
    const merged = messageSegments([reasoning('one', 1200), reasoning('two', 800)])[0]!
    expect(merged.kind === 'reasoning' && merged.durationMs).toBe(2000)

    const unfinished = messageSegments([reasoning('still going')])[0]!
    expect(unfinished.kind === 'reasoning' && unfinished.durationMs).toBeNull()

    // A run where only the closed part carries one must not report zero for the other.
    const partial = messageSegments([reasoning('one'), reasoning('two', 500)])[0]!
    expect(partial.kind === 'reasoning' && partial.durationMs).toBe(500)
  })

  it('places images where they occur rather than collecting them at the end', () => {
    const image: Part = { type: 'image', attachment_id: 7 }
    expect(messageSegments([text('before'), image, text('after')]).map(s => s.kind))
      .toEqual(['text', 'image', 'text'])
  })


})

describe('turnBlocks', () => {
  const blocks = (parts: Part[]) => turnBlocks(messageSegments(parts))
  const shape = (parts: Part[]) => blocks(parts).map(b => (b.kind === 'process' ? `process(${b.segments.length})` : b.segment.kind))

  it('folds a run of steps into one collapsible', () => {
    expect(shape([
      reasoning('planning'), call('a'), result('a'), reasoning('reading'), call('b'), result('b'),
      text('Here is what I found.'),
    ])).toEqual(['process(4)', 'text'])
  })

  it('never folds prose away, even written mid-chain', () => {
    // A model reporting progress before continuing is talking to the reader, not thinking aloud.
    expect(shape([
      reasoning('planning'), text('I will look this up.'), call('a'), result('a'), reasoning('done'),
      text('Here it is.'),
    ])).toEqual(['reasoning', 'text', 'process(2)', 'text'])
  })

  it('leaves a lone thought unwrapped, since it already collapses itself', () => {
    expect(shape([reasoning('thinking'), text('answer')])).toEqual(['reasoning', 'text'])
  })

  it('does not fold a run holding a tool still waiting on a person', () => {
    // A collapsible pinned open is a chevron that does nothing, around something needing an answer.
    expect(shape([reasoning('asking'), call('q', 'ask_user')])).toEqual(['reasoning', 'tool'])
  })

  it('leaves a lone answered call unwrapped, the way a lone thought is', () => {
    // The wrapper exists to collapse a sequence. One call is not one, and folding it puts a
    // chevron in front of the only thing the reader wanted — commonly an answered ask_user.
    expect(shape([text('Pick one.'), call('q', 'ask_user'), result('q', 'ask_user')]))
      .toEqual(['text', 'tool'])
  })

  it('still folds a call that came with thinking, which is a sequence', () => {
    expect(shape([reasoning('deciding'), call('q', 'ask_user'), result('q', 'ask_user')]))
      .toEqual(['process(2)'])
  })

  it('keeps images visible as output rather than folding them into the steps', () => {
    expect(shape([reasoning('drawing'), call('a'), result('a'), { type: 'image', attachment_id: 3 }]))
      .toEqual(['process(2)', 'image'])
  })

  it('reports a pending tool and adds up thinking time', () => {
    const waiting = messageSegments([reasoning('asking', 400), call('q', 'ask_user')])
    expect(hasPendingTool(waiting)).toBe(true)
    expect(totalReasoningMs(waiting)).toBe(400)

    const answered = messageSegments([reasoning('a', 300), call('x'), result('x'), reasoning('b', 700)])
    expect(hasPendingTool(answered)).toBe(false)
    expect(totalReasoningMs(answered)).toBe(1000)
    expect(totalReasoningMs(messageSegments([reasoning('untimed')]))).toBeNull()
  })
})
