import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { createSession, finalizeMessage, getSession, insertMessage, listMessages, maxSeq, toMessage, updateSession } from '@/server/plugins/hub/sessions'
import { createProject, deleteProject, getProject, listProjectSessions, listProjects, updateProject } from '@/server/plugins/hub/projects'
import { users } from '@/server/db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { connect } from './ws-helper'

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

describe('project realtime commands', () => {
  it('creates, updates, and deletes a project over the socket, broadcasting to two clients and moving sessions back to Chats', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const a = await connect()
    const b = await connect()

    a.ws.send(JSON.stringify({ type: 'project.create', name: 'Proj', system_prompt: 'sys' }))
    const created = await a.next('project.created')
    expect(created).toMatchObject({ type: 'project.created', project: { name: 'Proj', system_prompt: 'sys' } })
    expect(await b.next('project.created')).toEqual(created)
    const projectId = (created as { project: { id: number } }).project.id

    const session = await createSession(db, {
      user_id: DEFAULT_USER_ID, title: 't', project_id: projectId, provider_id: null, model_id: null,
    })

    a.ws.send(JSON.stringify({ type: 'project.update', project_id: projectId, name: 'Renamed' }))
    const updated = await a.next('project.updated')
    expect(updated).toMatchObject({ type: 'project.updated', project: { id: projectId, name: 'Renamed', system_prompt: 'sys' } })
    expect(await b.next('project.updated')).toEqual(updated)

    a.ws.send(JSON.stringify({ type: 'project.delete', project_id: projectId }))
    expect(await a.next('project.deleted')).toEqual({ type: 'project.deleted', project_id: projectId })
    expect(await b.next('project.deleted')).toEqual({ type: 'project.deleted', project_id: projectId })
    const moved = await a.next('session.updated')
    expect(moved).toMatchObject({ type: 'session.updated', session: { id: session.id, project_id: null } })
    expect(await b.next('session.updated')).toEqual(moved)
  })

  it('rejects moving a session to another user’s project, leaving it untouched', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const [other] = await db.insert(users).values({ name: 'other', settings: { plugins: {} }, created_at: 0 }).returning()
    const theirs = await createProject(db, { user_id: other!.id, name: 'theirs' })
    const s = await createSession(db, { user_id: DEFAULT_USER_ID, title: 't', provider_id: null, model_id: null })

    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'session.update', session_id: s.id, project_id: theirs.id, request_id: 'r1' }))
    expect(await next('error')).toMatchObject({ type: 'error', request_id: 'r1' })
    expect((await getSession(db, s.id))!.project_id).toBeNull()
  })

  it('answers a project.update for a project it does not own with an error carrying request_id', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const [other] = await db.insert(users).values({ name: 'other2', settings: { plugins: {} }, created_at: 0 }).returning()
    const theirs = await createProject(db, { user_id: other!.id, name: 'theirs' })

    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'project.update', project_id: theirs.id, name: 'stolen', request_id: 'r2' }))
    expect(await next('error')).toMatchObject({ type: 'error', request_id: 'r2' })
    expect((await getProject(db, theirs.id, other!.id))!.name).toBe('theirs')
  })
})
