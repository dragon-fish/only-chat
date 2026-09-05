import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSyncStore } from '@/client/stores/sync'
import type { Message, Session } from '@/shared/models'

const session: Session = { id: 1, user_id: 1, project_id: null, title: 't', head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null }
const msg = (id: number, parent_id: number | null, role: 'user' | 'assistant', over: Partial<Message> = {}): Message =>
  ({ id, session_id: 1, parent_id, seq: id, role, parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, ...over })

describe('sync store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('applies session and message events idempotently', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'session.created', session })
    expect(s.sessionList).toHaveLength(1)
    s.applyEvent({ type: 'message.created', message: msg(1, null, 'user') })
    s.applyEvent({ type: 'message.created', message: msg(2, 1, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'head.changed', session_id: 1, message_id: 2 })
    expect(s.streamingIds.has(2)).toBe(true)
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 0, kind: 'reasoning', delta: 'hm' })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 1, kind: 'text', delta: 'Hi' })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 1, kind: 'text', delta: '!' })
    expect(s.messages.get(1)!.get(2)!.parts).toEqual([{ type: 'reasoning', text: 'hm' }, { type: 'text', text: 'Hi!' }])
    s.applyEvent({ type: 'message.done', message_id: 2, status: 'done', usage: { prompt: 1 }, error: null })
    expect(s.messages.get(1)!.get(2)).toMatchObject({ status: 'done', usage: { prompt: 1 } })
    expect(s.streamingIds.has(2)).toBe(false)
    expect(s.pathFor(1).map((m) => m.id)).toEqual([1, 2])
  })

  it('keeps streaming state when REST data arrives with a stale status', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'snapshot', inflight: [msg(5, 4, 'assistant', { status: 'streaming', parts: [{ type: 'text', text: 'partial' }] })] })
    s.ingestMessages(1, [msg(4, null, 'user'), msg(5, 4, 'assistant', { status: 'error', error: 'interrupted' })])
    expect(s.messages.get(1)!.get(5)).toMatchObject({ status: 'streaming', parts: [{ type: 'text', text: 'partial' }] })
  })

  it('reconciles the streaming set from a snapshot so a finished stream can be overwritten', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'message.created', message: msg(4, null, 'user') })
    s.applyEvent({ type: 'message.created', message: msg(5, 4, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'head.changed', session_id: 1, message_id: 5 })
    expect(s.streamingIds.has(5)).toBe(true)
    // Reconnect: the stream finished while we were offline, so the snapshot no longer lists it.
    expect(s.snapshotSeq).toBe(0)
    s.applyEvent({ type: 'snapshot', inflight: [] })
    expect(s.streamingIds.has(5)).toBe(false)
    expect(s.snapshotSeq).toBe(1)
    s.ingestMessages(1, [msg(4, null, 'user'), msg(5, 4, 'assistant', { status: 'done', parts: [{ type: 'text', text: 'final' }] })])
    expect(s.messages.get(1)!.get(5)).toMatchObject({ status: 'done', parts: [{ type: 'text', text: 'final' }] })
    expect(s.isStreaming(1)).toBe(false)
    s.applyEvent({ type: 'snapshot', inflight: [] })
    expect(s.snapshotSeq).toBe(2)
  })

  it('ignores a duplicate streaming shell so accumulated parts survive', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'message.created', message: msg(2, null, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 0, kind: 'text', delta: 'Hi' })
    s.applyEvent({ type: 'message.created', message: msg(2, null, 'assistant', { status: 'streaming' }) })
    expect(s.messages.get(1)!.get(2)!.parts).toEqual([{ type: 'text', text: 'Hi' }])
    expect(s.streamingIds.has(2)).toBe(true)
  })

  it('drops the streaming ids of a deleted session', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'message.created', message: msg(7, null, 'assistant', { status: 'streaming' }) })
    expect(s.streamingIds.has(7)).toBe(true)
    s.applyEvent({ type: 'session.deleted', session_id: 1 })
    expect(s.streamingIds.has(7)).toBe(false)
    expect(s.streamingIds.size).toBe(0)
  })

  it('computes siblings for the branch switcher', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.ingestMessages(1, [msg(1, null, 'user'), msg(2, 1, 'assistant'), msg(3, 1, 'assistant')])
    expect(s.siblingsOf(1, 3).map((m) => m.id)).toEqual([2, 3])
  })

  it('removes a deleted session and its messages', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.ingestMessages(1, [msg(1, null, 'user')])
    s.applyEvent({ type: 'session.deleted', session_id: 1 })
    expect(s.sessions.size).toBe(0)
    expect(s.messages.has(1)).toBe(false)
  })
})
