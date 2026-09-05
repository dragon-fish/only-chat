import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { createSession, finalizeMessage, getSession, insertMessage, listMessages, maxSeq, toMessage, updateSession } from '@/server/plugins/hub/sessions'
import { createProject, deleteProject, getProject, listProjectSessions, listProjects, updateProject } from '@/server/plugins/hub/projects'
import { users } from '@/server/db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'

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

describe('project ops', () => {
  it('scopes every read and write to the owning user', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const [other] = await db.insert(users).values({ name: 'other', settings: { plugins: {} }, created_at: 0 }).returning()
    const mine = await createProject(db, { user_id: DEFAULT_USER_ID, name: 'mine', system_prompt: 'P', params: { temperature: 0.2 } })
    const theirs = await createProject(db, { user_id: other!.id, name: 'theirs' })

    expect(await getProject(db, mine.id, DEFAULT_USER_ID)).toMatchObject({ name: 'mine', system_prompt: 'P', params: { temperature: 0.2 } })
    expect(await getProject(db, theirs.id, DEFAULT_USER_ID)).toBeUndefined()
    expect((await listProjects(db, DEFAULT_USER_ID)).map((p) => p.id)).toEqual([mine.id])

    await expect(updateProject(db, theirs.id, DEFAULT_USER_ID, { name: 'stolen' })).rejects.toThrow()
    const renamed = await updateProject(db, mine.id, DEFAULT_USER_ID, { name: 'renamed', provider_id: null })
    expect(renamed).toMatchObject({ name: 'renamed', system_prompt: 'P' })

    // A cross-user delete must be distinguishable from a real one, not a silent no-op.
    await expect(deleteProject(db, theirs.id, DEFAULT_USER_ID)).rejects.toThrow()
    expect(await getProject(db, theirs.id, other!.id)).toBeDefined()
  })

  it('lists a project’s sessions and releases them to Chats when it is deleted', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const p = await createProject(db, { user_id: DEFAULT_USER_ID, name: 'p' })
    const s = await createSession(db, {
      user_id: DEFAULT_USER_ID, title: 't', project_id: p.id, provider_id: null, model_id: null,
      system_prompt: 'draft prompt', params: { temperature: 0 },
    })
    expect(s).toMatchObject({ project_id: p.id, system_prompt: 'draft prompt', params: { temperature: 0 } })
    expect((await listProjectSessions(db, p.id, DEFAULT_USER_ID)).map((r) => r.id)).toEqual([s.id])

    expect(await deleteProject(db, p.id, DEFAULT_USER_ID)).toMatchObject({ id: p.id })
    expect((await getSession(db, s.id))!.project_id).toBeNull()
  })
})
