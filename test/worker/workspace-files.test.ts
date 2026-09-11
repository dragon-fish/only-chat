import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { attachments, conversations, projects, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { WorkspaceFiles, type WorkspaceStorage } from '@/server/plugins/workspace-files/service'
import { ensureTestUser } from './auth-helper'

interface Fixture {
  db: DB
  files: WorkspaceFiles
  projectId: number
  conversationId: number
}

/** The service only needs storage, so it is built directly rather than through a Durable Object. */
async function fixture(): Promise<Fixture> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  await db.delete(workspaceFileVersions)
  await db.delete(workspaceFiles)
  const [project] = await db.insert(projects).values({
    user_id: 1, name: 'p', icon_attachment_id: null, system_prompt: null,
    provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0,
  }).returning()
  const [conversation] = await db.insert(conversations).values({
    user_id: 1, project_id: project!.id, title: 'c', head_message_id: null, provider_id: null,
    model_id: null, system_prompt: null, params: null, tools: [], created_at: 0, updated_at: 0,
  }).returning()
  // In-memory object storage: these tests are about the filesystem's rules, not about R2.
  const objects = new Map<string, Uint8Array>()
  const storage: WorkspaceStorage = {
    put: async (key, bytes) => { objects.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) },
    getBytes: async (key) => {
      const bytes = objects.get(key)
      return bytes ? { bytes } : null
    },
  }
  const files = new WorkspaceFiles(db, storage, 1)
  return { db, files, projectId: project!.id, conversationId: conversation!.id }
}

const scope = (f: Fixture) => ({ conversationId: f.conversationId, projectId: f.projectId })

describe('workspace files service', () => {
  let f: Fixture
  beforeEach(async () => { f = await fixture() })

  it('creates a file and reports what was written', async () => {
    const result = await f.files.write({ path: '/project/report.md', content: '# Report\nBody', ...scope(f) })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value).toMatchObject({ operation: 'created', version: 1, totalLines: 2, fileSize: 13 })
  })

  it('requires the current version to update, and refuses a stale one', async () => {
    await f.files.write({ path: '/project/a.md', content: 'one', ...scope(f) })

    const missing = await f.files.write({ path: '/project/a.md', content: 'two', ...scope(f) })
    expect(missing).toMatchObject({ ok: false, error: 'VERSION_REQUIRED' })

    const stale = await f.files.write({ path: '/project/a.md', content: 'two', expectedVersion: 99, ...scope(f) })
    expect(stale).toMatchObject({ ok: false, error: 'VERSION_CONFLICT' })

    const good = await f.files.write({ path: '/project/a.md', content: 'two', expectedVersion: 1, ...scope(f) })
    expect(good).toMatchObject({ ok: true })
    if (good.ok) expect(good.value).toMatchObject({ operation: 'updated', version: 2 })
  })

  it('leaves no orphan version behind when the pointer does not move', async () => {
    await f.files.write({ path: '/project/a.md', content: 'one', ...scope(f) })
    await f.files.write({ path: '/project/a.md', content: 'bad', expectedVersion: 99, ...scope(f) })

    const [file] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'a.md'))
    const versions = await f.db.select().from(workspaceFileVersions).where(eq(workspaceFileVersions.file_id, file!.id))
    // The losing write must be invisible in both places, not just in the pointer.
    expect(file!.current_version).toBe(1)
    expect(versions).toHaveLength(1)
  })

  it('refuses a blind write over an existing path', async () => {
    await f.files.write({ path: '/project/a.md', content: 'one', ...scope(f) })
    // Not FILE_ALREADY_EXISTS: that is reserved for a create that loses the unique index to a
    // concurrent create. A model that simply forgot the version is told to go read it.
    const again = await f.files.write({ path: '/project/a.md', content: 'two', ...scope(f) })
    expect(again).toMatchObject({ ok: false, error: 'VERSION_REQUIRED' })
  })

  it('reads back numbered lines with the range it actually returned', async () => {
    await f.files.write({ path: '/conversation/notes.md', content: 'a\nb\nc\nd', conversationId: f.conversationId, projectId: null })
    const result = await f.files.read({ path: '/conversation/notes.md', offset: 2, limit: 2, ...scope(f) })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value).toMatchObject({
      content: '2 | b\n3 | c', startLine: 2, returnedLines: 2, totalLines: 4, truncated: true, nextOffset: 4, version: 1,
    })
  })

  it('separates an empty file from a file holding one newline', async () => {
    await f.files.write({ path: '/project/empty.md', content: '', ...scope(f) })
    await f.files.write({ path: '/project/newline.md', content: '\n', ...scope(f) })

    const empty = await f.files.read({ path: '/project/empty.md', ...scope(f) })
    const newline = await f.files.read({ path: '/project/newline.md', ...scope(f) })
    expect(empty.ok && empty.value.totalLines).toBe(0)
    expect(empty.ok && empty.value.empty).toBe(true)
    expect(newline.ok && newline.value.totalLines).toBe(2)
  })

  it('keeps the two mounts apart', async () => {
    await f.files.write({ path: '/project/same.md', content: 'project', ...scope(f) })
    await f.files.write({ path: '/conversation/same.md', content: 'conversation', ...scope(f) })
    const fromProject = await f.files.read({ path: '/project/same.md', ...scope(f) })
    const fromConversation = await f.files.read({ path: '/conversation/same.md', ...scope(f) })
    expect(fromProject.ok && fromProject.value.content).toContain('project')
    expect(fromConversation.ok && fromConversation.value.content).toContain('conversation')
  })

  it('reports an unavailable project mount instead of failing', async () => {
    const result = await f.files.write({ path: '/project/x.md', content: 'x', conversationId: f.conversationId, projectId: null })
    expect(result).toMatchObject({ ok: false, error: 'MOUNT_UNAVAILABLE' })
  })

  it('lists both mounts at the root with their availability', async () => {
    const listed = await f.files.list({ path: '/', conversationId: f.conversationId, projectId: null })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.entries).toEqual([
      expect.objectContaining({ path: '/project', type: 'mount', status: 'unavailable' }),
      expect.objectContaining({ path: '/conversation', type: 'mount', status: 'empty' }),
    ])
  })

  it('lists direct children only, folding deeper paths into directories', async () => {
    await f.files.write({ path: '/project/root.md', content: 'r', ...scope(f) })
    await f.files.write({ path: '/project/notes/day-1.md', content: 'd', ...scope(f) })
    await f.files.write({ path: '/project/notes/day-2.md', content: 'd', ...scope(f) })

    const listed = await f.files.list({ path: '/project', ...scope(f) })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.entries.map(entry => [entry.path, entry.type])).toEqual([
      ['/project/notes', 'directory'],
      ['/project/root.md', 'file'],
    ])
  })

  it('deduplicates identical bytes into one attachment', async () => {
    const content = `same bytes ${crypto.randomUUID()}`
    const one = await f.files.write({ path: '/project/one.md', content, ...scope(f) })
    const two = await f.files.write({ path: '/project/two.md', content, ...scope(f) })
    expect(one.ok && two.ok).toBe(true)

    const versions = await f.db.select().from(workspaceFileVersions)
    const used = new Set(versions.map(version => version.attachment_id))
    // Two files, two versions, one stored object.
    expect(versions).toHaveLength(2)
    expect(used.size).toBe(1)

    const rows = await f.db.select().from(attachments).where(eq(attachments.id, [...used][0]!))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.size).toBe(new TextEncoder().encode(content).byteLength)
  })

  it('refuses a path the model may not name', async () => {
    for (const path of ['/project/../secret', '/memory/x', 'relative.md', '/project/x/']) {
      expect(await f.files.write({ path, content: 'x', ...scope(f) })).toMatchObject({ ok: false, error: 'INVALID_PATH' })
    }
  })

  it('reports a missing file rather than inventing one', async () => {
    const result = await f.files.read({ path: '/project/nope.md', ...scope(f) })
    expect(result).toMatchObject({ ok: false, error: 'FILE_NOT_FOUND' })
  })
})
