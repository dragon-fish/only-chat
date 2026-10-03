import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { attachments, conversations, pluginConfigs, projects, users, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { WorkspaceFiles, type WorkspaceScope, type WorkspaceStorage } from '@/server/plugins/workspace-files/service'
import type { FileRecord } from '@/shared/workspace-files'
import { ensureTestUser, workerFetch, type AuthTestClient } from './auth-helper'

const API = '/api/plugins/workspace_files'

/** The real bucket: the REST routes read through the Worker's own Assets service. */
const storage: WorkspaceStorage = {
  put: async (key, bytes, mime) => { await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } }) },
  delete: async (key) => { await env.BUCKET.delete(key) },
  getBytes: async (key) => {
    const object = await env.BUCKET.get(key)
    return object ? { bytes: new Uint8Array(await object.arrayBuffer()) } : null
  },
}

interface Fixture {
  db: DB
  client: AuthTestClient
  files: WorkspaceFiles
  projectId: number
  otherProjectId: number
  /** In `projectId`. */
  conversationId: number
  /** In `otherProjectId`. */
  otherConversationId: number
  /** In no Project. */
  looseConversationId: number
}

async function newProject(db: DB, name: string) {
  const [row] = await db.insert(projects).values({
    user_id: 1, name, icon_attachment_id: null, system_prompt: null,
    provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0,
  }).returning()
  return row!.id
}

async function newConversation(db: DB, projectId: number | null) {
  const [row] = await db.insert(conversations).values({
    user_id: 1, project_id: projectId, title: 'c', head_message_id: null, provider_id: null,
    model_id: null, system_prompt: null, params: null, tools: [], created_at: 0, updated_at: 0,
  }).returning()
  return row!.id
}

async function setMemorySwitch(db: DB, on: boolean) {
  const [user] = await db.select().from(users).where(eq(users.id, 1))
  await db.update(users).set({ settings: { ...user!.settings, plugins: { ...user!.settings.plugins, memory: on } } }).where(eq(users.id, 1))
}

async function fixture(): Promise<Fixture> {
  const db = createDb(env.DB)
  const client = await ensureTestUser(db)
  await db.delete(workspaceFileVersions)
  await db.delete(workspaceFiles)
  await db.delete(attachments)
  await db.delete(pluginConfigs)
  await setMemorySwitch(db, false)
  const projectId = await newProject(db, 'p')
  const otherProjectId = await newProject(db, 'q')
  return {
    db, client, files: new WorkspaceFiles(db, storage, 1),
    projectId, otherProjectId,
    conversationId: await newConversation(db, projectId),
    otherConversationId: await newConversation(db, otherProjectId),
    looseConversationId: await newConversation(db, null),
  }
}

const open = (conversationId: number, projectId: number | null): WorkspaceScope => ({ conversationId, projectId, memory: true })
const closed = (conversationId: number, projectId: number | null): WorkspaceScope => ({ conversationId, projectId, memory: false })

async function text(files: WorkspaceFiles, path: string, scope: WorkspaceScope) {
  const read = await files.read({ path, ...scope })
  // `read` numbers its lines for the model; these tests only care what the file says.
  return read.ok ? read.value.content.replace(/^\s*\d+ \| /gm, '') : read.error
}

describe('memory mounts', () => {
  let f: Fixture
  beforeEach(async () => { f = await fixture() })

  it('keeps /memory/project and /project apart under the same name', async () => {
    const scope = open(f.conversationId, f.projectId)
    await f.files.write({ path: '/project/a.md', content: 'shared file', ...scope })
    await f.files.write({ path: '/memory/project/a.md', content: 'project memory', ...scope })

    expect(await text(f.files, '/project/a.md', scope)).toBe('shared file')
    expect(await text(f.files, '/memory/project/a.md', scope)).toBe('project memory')
    const listed = await f.files.listRecords('project', scope)
    expect(listed.ok && listed.value.map(file => file.path)).toEqual(['/project/a.md'])
  })

  it('shares user memory across conversations of different Projects, and project memory only within one', async () => {
    await f.files.write({ path: '/memory/user/prefs.md', content: 'terse', ...open(f.conversationId, f.projectId) })
    await f.files.write({ path: '/memory/project/ctx.md', content: 'p only', ...open(f.conversationId, f.projectId) })

    expect(await text(f.files, '/memory/user/prefs.md', open(f.otherConversationId, f.otherProjectId))).toBe('terse')
    expect(await text(f.files, '/memory/user/prefs.md', open(f.looseConversationId, null))).toBe('terse')
    expect(await text(f.files, '/memory/project/ctx.md', open(f.otherConversationId, f.otherProjectId))).toBe('FILE_NOT_FOUND')
  })

  it('has no project memory for a conversation outside any Project', async () => {
    const written = await f.files.write({ path: '/memory/project/x.md', content: 'x', ...open(f.looseConversationId, null) })
    expect(written).toEqual({ ok: false, error: 'MOUNT_UNAVAILABLE' })
  })

  it('cannot reach either memory mount while memory is closed, and does not list them', async () => {
    await f.files.write({ path: '/memory/user/prefs.md', content: 'terse', ...open(f.conversationId, f.projectId) })
    const scope = closed(f.conversationId, f.projectId)

    expect(await text(f.files, '/memory/user/prefs.md', scope)).toBe('MOUNT_UNAVAILABLE')
    expect(await f.files.write({ path: '/memory/user/new.md', content: 'x', ...scope })).toEqual({ ok: false, error: 'MOUNT_UNAVAILABLE' })
    const root = await f.files.list({ path: '/', ...scope })
    expect(root.ok && root.value.entries.map(entry => entry.path)).toEqual(['/project', '/conversation'])
    expect((await f.files.list({ path: '/memory', ...scope })).ok).toBe(false)

    const opened = await f.files.list({ path: '/memory', ...open(f.conversationId, f.projectId) })
    expect(opened.ok && opened.value.entries.map(entry => [entry.path, entry.status])).toEqual([
      ['/memory/user', 'ready'], ['/memory/project', 'empty'],
    ])
  })

  it('moves a file into memory and back, keeping its identity', async () => {
    const scope = open(f.conversationId, f.projectId)
    await f.files.write({ path: '/conversation/draft.md', content: 'keep', ...scope })
    const [before] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'draft.md'))

    expect((await f.files.rename({ path: '/conversation/draft.md', toPath: '/memory/user/draft.md', ...scope })).ok).toBe(true)
    const [moved] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.id, before!.id))
    expect(moved).toMatchObject({ mount: 'memory/user', project_id: null, conversation_id: null })

    expect((await f.files.rename({ path: '/memory/user/draft.md', toPath: '/memory/project/draft.md', ...scope })).ok).toBe(true)
    expect(await text(f.files, '/memory/project/draft.md', scope)).toBe('keep')
  })

  it('puts deleted user memory in the trash rather than among orphans, and restores it', async () => {
    const scope = open(f.conversationId, f.projectId)
    await f.files.write({ path: '/memory/user/prefs.md', content: 'terse', ...scope })
    await f.files.write({ path: '/conversation/gone.md', content: 'orphan', ...scope })
    await f.files.deleteByPath({ path: '/memory/user/prefs.md', ...scope })
    await f.files.detachConversationFiles(f.conversationId)

    expect((await f.files.listTrash()).map(file => file.path)).toEqual(['/memory/user/prefs.md'])
    expect((await f.files.listOrphans()).map(file => file.path)).toEqual(['/conversation/gone.md'])

    // Emptying the orphans is permanent; it must never reach a memory.
    await f.files.purge((await f.files.listOrphans()).map(file => file.id))
    const [trashed] = await f.files.listTrash()
    expect((await f.files.undelete(trashed!.id)).ok).toBe(true)
    expect(await text(f.files, '/memory/user/prefs.md', scope)).toBe('terse')
  })

  it('previews /memory/project/a.html, not the /project file of the same name', async () => {
    await setMemorySwitch(f.db, true)
    const scope = open(f.conversationId, f.projectId)
    await f.files.write({ path: '/project/a.html', content: 'project page', ...scope })
    await f.files.write({ path: '/memory/project/a.html', content: 'memory page', ...scope })
    const [memory] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.mount, 'memory/project'))

    const body = await (await f.client.request(`${API}/files/${memory!.id}`, { method: 'GET' })).json() as { previewUrl: string }
    expect(await (await workerFetch(body.previewUrl)).text()).toBe('memory page')
  })

  it('lists memory beside the conversation files only while the switch is on', async () => {
    const scope = open(f.conversationId, f.projectId)
    await f.files.write({ path: '/memory/user/prefs.md', content: 'terse', ...scope })
    await f.files.write({ path: '/memory/project/ctx.md', content: 'ctx', ...scope })

    type Listing = { files: FileRecord[], memoryFiles?: { user: FileRecord[], project: FileRecord[] } }
    const off = await (await f.client.request(`${API}/conversations/${f.conversationId}/files`, { method: 'GET' })).json() as Listing
    expect(off.memoryFiles).toBeUndefined()

    await setMemorySwitch(f.db, true)
    const on = await (await f.client.request(`${API}/conversations/${f.conversationId}/files`, { method: 'GET' })).json() as Listing
    expect(on.memoryFiles!.user.map(file => file.path)).toEqual(['/memory/user/prefs.md'])
    expect(on.memoryFiles!.project.map(file => file.path)).toEqual(['/memory/project/ctx.md'])
    expect(on.files).toEqual([])

    const archive = await f.client.request(`${API}/projects/${f.projectId}/memory/archive`, { method: 'GET' })
    expect(archive.status).toBe(200)
  })
})
