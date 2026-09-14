import { describe, expect, it } from 'vitest'
import { completedToolState } from '@/server/plugins/hub/tool-state'
import { canContinueToolMessage } from '@/client/components/tool-part-renderer'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'

const ask = (id: string): Part => ({
  type: 'tool_call',
  id,
  name: 'ask_user',
  args: { questions: [{ id: 'q', header: 'Q', question: 'Which?', type: 'text' }] },
})
const search = (id: string): Part => ({ type: 'tool_call', id, name: 'web_search', args: { query: 'x' } })
const searched = (id: string): Part => ({
  type: 'tool_result', call_id: id, name: 'web_search', content: { query: 'x', results: [] },
})
const answered = (id: string): Part => ({
  type: 'tool_result', call_id: id, name: 'ask_user',
  content: { status: 'answered', answers: [{ id: 'q', value: 'yes' }] },
})
const cancelled = (id: string): Part => ({
  type: 'tool_result', call_id: id, name: 'ask_user', content: { status: 'cancelled', message: 'no' },
})

const message = (parts: Part[]): Message => ({
  id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', parts,
  provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
})

const skipped = (name: string, content: unknown) => name === 'ask_user' && (content as { status?: string }).status === 'cancelled'

describe('completedToolState', () => {
  // A model may search and ask in one breath; the searches say nothing about whether the person answered.
  it('resumes once the questions are answered, however many tools ran alongside them', () => {
    expect(completedToolState([
      search('s1'), search('s2'), ask('a1'),
      searched('s1'), searched('s2'), answered('a1'),
    ], skipped)).toBe('answered')
  })

  it('still waits while any call lacks a result', () => {
    expect(completedToolState([search('s1'), ask('a1'), answered('a1')], skipped)).toBe('waiting')
    expect(completedToolState([search('s1'), ask('a1'), searched('s1')], skipped)).toBe('waiting')
  })

  it('reports a cancelled question even when its neighbours succeeded', () => {
    expect(completedToolState([search('s1'), ask('a1'), searched('s1'), cancelled('a1')], skipped)).toBe('cancelled')
  })

  it('treats a step of executed tools as complete rather than as something to ask about', () => {
    expect(completedToolState([search('s1'), searched('s1')], skipped)).toBe('answered')
  })
})

describe('canContinueToolMessage', () => {
  const at = (parts: Part[]) => {
    const m = message(parts)
    return canContinueToolMessage(m, [m], m.id)
  }

  it('offers recovery for a mixed step whose questions are answered', () => {
    expect(at([search('s1'), ask('a1'), searched('s1'), answered('a1')])).toBe(true)
  })

  it('withholds it while a question is unanswered, or a neighbour never returned', () => {
    expect(at([search('s1'), ask('a1'), searched('s1')])).toBe(false)
    expect(at([search('s1'), ask('a1'), answered('a1')])).toBe(false)
  })

  it('withholds it when nothing asked the human anything', () => {
    expect(at([search('s1'), searched('s1')])).toBe(false)
  })

  it('withholds it once the turn already continued', () => {
    const m = message([ask('a1'), answered('a1')])
    const child: Message = { ...m, id: 2, parent_id: 1, parts: [{ type: 'text', text: 'done' }] }
    expect(canContinueToolMessage(m, [m, child], m.id)).toBe(false)
  })
})
