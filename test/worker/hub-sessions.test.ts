import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { createSession, finalizeMessage, insertMessage, listMessages, maxSeq, toMessage, updateSession } from '@/server/plugins/hub/sessions'

describe('session ops', () => {
  it('creates, inserts, finalizes, and reads back with wire status', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const s = await createSession(db, { user_id: 1, title: 't', provider_id: null, model_id: null })
    expect(await maxSeq(db, s.id)).toBe(0)
    const u = await insertMessage(db, { session_id: s.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hi' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1 })
    const a = await insertMessage(db, { session_id: s.id, parent_id: u.id, seq: 2, role: 'assistant', parts: [], provider_id: null, model_id: 'm', usage: null, status: 'error', error: null, created_at: 2 })
    await finalizeMessage(db, a.id, { parts: [{ type: 'text', text: 'yo' }], usage: { prompt: 1 }, status: 'done', error: null })
    const rows = await listMessages(db, s.id)
    expect(rows.map((r) => r.status)).toEqual(['done', 'done'])
    expect(toMessage(rows[1]!, 'streaming').status).toBe('streaming')
    expect(await maxSeq(db, s.id)).toBe(2)
    const s2 = await updateSession(db, s.id, { head_message_id: a.id, title: 'renamed' })
    expect(s2.head_message_id).toBe(a.id)
    expect(s2.updated_at).toBeGreaterThanOrEqual(s.updated_at)
  })
})
