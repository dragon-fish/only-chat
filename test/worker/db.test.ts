import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { messages, sessions, users } from '@/server/db/schema'

describe('D1 schema', () => {
  it('inserts a session and a message tree', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [s] = await db.insert(sessions).values({
      user_id: 1, title: 't', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    const [u] = await db.insert(messages).values({
      session_id: s!.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hi' }],
      provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 2,
    }).returning()
    const [a] = await db.insert(messages).values({
      session_id: s!.id, parent_id: u!.id, seq: 2, role: 'assistant', parts: [],
      provider_id: null, model_id: 'm', usage: { prompt: 1, completion: 0 }, status: 'error', error: null, created_at: 3,
    }).returning()
    const rows = await db.select().from(messages).where(eq(messages.session_id, s!.id)).orderBy(messages.seq)
    expect(rows.map((r) => r.id)).toEqual([u!.id, a!.id])
    expect(rows[1]!.usage).toEqual({ prompt: 1, completion: 0 })
    expect(rows[0]!.parts).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('enforces unique (session_id, seq)', async () => {
    const db = createDb(env.DB)
    const [s] = await db.insert(sessions).values({
      user_id: 1, title: 't2', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    const row = {
      session_id: s!.id, parent_id: null, seq: 1, role: 'user' as const, parts: [],
      provider_id: null, model_id: null, usage: null, status: 'done' as const, error: null, created_at: 0,
    }
    await db.insert(messages).values(row)
    await expect(db.insert(messages).values(row)).rejects.toThrow()
  })
})
