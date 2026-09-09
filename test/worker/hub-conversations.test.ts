import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureTestUser as seedTestUser } from './auth-helper'
import { createConversation, finalizeMessage, forkConversation, getConversation, insertMessage, listMessages, maxSeq, toMessage, updateConversation } from '@/server/plugins/hub/conversations'
import { createProject, deleteProject, getProject, listProjectConversations, listProjects, updateProject } from '@/server/plugins/hub/projects'
import { users } from '@/server/db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { connect } from './ws-helper'

describe('conversation ops', () => {
  it('creates, inserts, finalizes, and reads back with wire status', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const s = await createConversation(db, { user_id: 1, title: 't', provider_id: null, model_id: null })
    expect(await maxSeq(db, s.id)).toBe(0)
    const u = await insertMessage(db, { conversation_id: s.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hi' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1 })
    const a = await insertMessage(db, { conversation_id: s.id, parent_id: u.id, seq: 2, role: 'assistant', parts: [], provider_id: null, model_id: 'm', usage: null, status: 'error', error: null, created_at: 2 })
    await finalizeMessage(db, a.id, { parts: [{ type: 'text', text: 'yo' }], usage: { prompt: 1 }, status: 'done', error: null })
    const rows = await listMessages(db, s.id)
    expect(rows.map((r) => r.status)).toEqual(['done', 'done'])
    expect(toMessage(rows[1]!, 'streaming').status).toBe('streaming')
    expect(await maxSeq(db, s.id)).toBe(2)
    const s2 = await updateConversation(db, s.id, { head_message_id: a.id, title: 'renamed' })
    expect(s2.head_message_id).toBe(a.id)
    expect(s2.updated_at).toBeGreaterThanOrEqual(s.updated_at)
  })

  it('defaults existing Conversation snapshots to empty and preserves a selected tool snapshot', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const empty = await createConversation(db, { user_id: 1, title: 'empty', provider_id: null, model_id: null })
    const selected = await createConversation(db, { user_id: 1, title: 'selected', provider_id: null, model_id: null, tools: ['ask_user'] })
    expect(empty.tools).toEqual([])
    expect(selected.tools).toEqual(['ask_user'])
  })

  it('forks only the root-to-selected-message path with remapped parents and copied settings', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const source = await createConversation(db, {
      user_id: 1, title: 'Source', provider_id: 7, model_id: 'model',
      system_prompt: 'prompt', params: { temperature: 0.3 },
    })
    const root = await insertMessage(db, { conversation_id: source.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'root' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1 })
    const selected = await insertMessage(db, { conversation_id: source.id, parent_id: root.id, seq: 2, role: 'assistant', parts: [{ type: 'text', text: 'selected' }], provider_id: 7, model_id: 'model', usage: { prompt: 10, completion: 2 }, status: 'done', error: null, created_at: 2 })
    await insertMessage(db, { conversation_id: source.id, parent_id: root.id, seq: 3, role: 'assistant', parts: [{ type: 'text', text: 'other branch' }], provider_id: 7, model_id: 'model', usage: null, status: 'done', error: null, created_at: 3 })
    await updateConversation(db, source.id, { head_message_id: selected.id })

    const forked = await forkConversation(db, source.id, 1, selected.id)
    expect(forked).toMatchObject({ title: 'Source 副本', project_id: null, provider_id: 7, model_id: 'model', system_prompt: 'prompt', params: { temperature: 0.3 } })
    const copied = await listMessages(db, forked.id)
    expect(copied.map(message => ({ role: message.role, text: message.parts[0], usage: message.usage }))).toEqual([
      { role: 'user', text: { type: 'text', text: 'root' }, usage: null },
      { role: 'assistant', text: { type: 'text', text: 'selected' }, usage: { prompt: 10, completion: 2 } },
    ])
    expect(copied[0]!.parent_id).toBeNull()
    expect(copied[1]!.parent_id).toBe(copied[0]!.id)
    expect(forked.head_message_id).toBe(copied[1]!.id)
  })
})

describe('project ops', () => {
  it('scopes every read and write to the owning user', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const [other] = await db.insert(users).values({ name: 'other', settings: { plugins: {} }, createdAt: new Date(0), updatedAt: new Date(0), email: crypto.randomUUID() + '@example.com' }).returning()
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

  it('lists a project’s conversations and releases them to Chats when it is deleted', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const p = await createProject(db, { user_id: DEFAULT_USER_ID, name: 'p' })
    const s = await createConversation(db, {
      user_id: DEFAULT_USER_ID, title: 't', project_id: p.id, provider_id: null, model_id: null,
      system_prompt: 'draft prompt', params: { temperature: 0 },
    })
    expect(s).toMatchObject({ project_id: p.id, system_prompt: 'draft prompt', params: { temperature: 0 } })
    expect((await listProjectConversations(db, p.id, DEFAULT_USER_ID)).map((r) => r.id)).toEqual([s.id])

    expect(await deleteProject(db, p.id, DEFAULT_USER_ID)).toMatchObject({ id: p.id })
    expect((await getConversation(db, s.id))!.project_id).toBeNull()
  })
})

describe('project realtime commands', () => {
  it('creates, updates, and deletes a project over the socket, broadcasting to two clients and moving conversations back to Chats', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const a = await connect()
    const b = await connect()

    a.ws.send(JSON.stringify({ type: 'project.create', name: '🐍 Proj', system_prompt: 'sys' }))
    const created = await a.next('project.created')
    expect(created).toMatchObject({ type: 'project.created', project: { name: '🐍 Proj', system_prompt: 'sys', icon_attachment_id: null } })
    expect(await b.next('project.created')).toEqual(created)
    const projectId = (created as { project: { id: number } }).project.id

    const conversation = await createConversation(db, {
      user_id: DEFAULT_USER_ID, title: 't', project_id: projectId, provider_id: null, model_id: null,
    })

    a.ws.send(JSON.stringify({ type: 'project.update', project_id: projectId, name: 'Renamed' }))
    const updated = await a.next('project.updated')
    expect(updated).toMatchObject({ type: 'project.updated', project: { id: projectId, name: 'Renamed', system_prompt: 'sys' } })
    expect(await b.next('project.updated')).toEqual(updated)

    a.ws.send(JSON.stringify({ type: 'project.delete', project_id: projectId }))
    expect(await a.next('project.deleted')).toEqual({ type: 'project.deleted', project_id: projectId })
    expect(await b.next('project.deleted')).toEqual({ type: 'project.deleted', project_id: projectId })
    const moved = await a.next('conversation.updated')
    expect(moved).toMatchObject({ type: 'conversation.updated', conversation: { id: conversation.id, project_id: null } })
    expect(await b.next('conversation.updated')).toEqual(moved)
  })

  it('rejects moving a conversation to another user’s project, leaving it untouched', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const [other] = await db.insert(users).values({ name: 'other', settings: { plugins: {} }, createdAt: new Date(0), updatedAt: new Date(0), email: crypto.randomUUID() + '@example.com' }).returning()
    const theirs = await createProject(db, { user_id: other!.id, name: 'theirs' })
    const s = await createConversation(db, { user_id: DEFAULT_USER_ID, title: 't', provider_id: null, model_id: null })

    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'conversation.update', conversation_id: s.id, project_id: theirs.id, request_id: 'r1' }))
    expect(await next('error')).toMatchObject({ type: 'error', request_id: 'r1' })
    expect((await getConversation(db, s.id))!.project_id).toBeNull()
  })

  it('answers a project.update for a project it does not own with an error carrying request_id', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const [other] = await db.insert(users).values({ name: 'other2', settings: { plugins: {} }, createdAt: new Date(0), updatedAt: new Date(0), email: crypto.randomUUID() + '@example.com' }).returning()
    const theirs = await createProject(db, { user_id: other!.id, name: 'theirs' })

    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'project.update', project_id: theirs.id, name: 'stolen', request_id: 'r2' }))
    expect(await next('error')).toMatchObject({ type: 'error', request_id: 'r2' })
    expect((await getProject(db, theirs.id, other!.id))!.name).toBe('theirs')
  })

  it('correlates a conversation fork while broadcasting the created conversation', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const source = await createConversation(db, { user_id: 1, title: 'Source', provider_id: null, model_id: null })
    const root = await insertMessage(db, { conversation_id: source.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'root' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1 })
    await updateConversation(db, source.id, { head_message_id: root.id })
    const a = await connect()
    const b = await connect()

    a.ws.send(JSON.stringify({ type: 'conversation.fork', request_id: 'fork-1', conversation_id: source.id, message_id: root.id }))
    const created = await a.next('conversation.created')
    expect(await b.next('conversation.created')).toEqual(created)
    const done = await a.next('conversation.forked')
    expect(done).toMatchObject({ request_id: 'fork-1', conversation_id: (created as { conversation: { id: number } }).conversation.id })
    expect(await b.next('conversation.forked')).toEqual(done)
  })
})
