import { describe, expect, it } from 'vitest'
import { messageSegments } from '@/client/components/message-segments'
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

  it('drops empty text and reasoning so a signature-only part renders nothing', () => {
    expect(messageSegments([reasoning('  '), text(''), call('a')]).map(s => s.kind)).toEqual(['tool'])
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
