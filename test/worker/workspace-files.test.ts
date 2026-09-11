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

  it('overwrites without a version, and says what it replaced', async () => {
    await f.files.write({ path: '/project/a.md', content: 'one', ...scope(f) })

    // Refusing here would throw away whatever the model spent producing `two`, to protect a version
    // that is not going anywhere. The write lands and the reply says what it displaced.
    const blind = await f.files.write({ path: '/project/a.md', content: 'two', ...scope(f) })
    expect(blind).toMatchObject({ ok: true })
    if (blind.ok) expect(blind.value).toMatchObject({ operation: 'replaced', version: 2, replacedVersion: 1 })
  })

  it('still refuses a write that names the wrong version', async () => {
    await f.files.write({ path: '/project/a.md', content: 'one', ...scope(f) })

    // Passing a version is a claim about what the file currently is. A wrong claim is a real
    // conflict — someone else moved it — and silently overwriting would lose their work.
    const stale = await f.files.write({ path: '/project/a.md', content: 'two', expectedVersion: 99, ...scope(f) })
    expect(stale).toMatchObject({ ok: false, error: 'VERSION_CONFLICT' })

    const good = await f.files.write({ path: '/project/a.md', content: 'two', expectedVersion: 1, ...scope(f) })
    expect(good).toMatchObject({ ok: true })
    if (good.ok) expect(good.value).toMatchObject({ operation: 'updated', version: 2, replacedVersion: null })
  })

  it('restores an old version under a new name, leaving both intact', async () => {
    await f.files.write({ path: '/project/a.md', content: 'original', ...scope(f) })
    await f.files.write({ path: '/project/a.md', content: 'overwritten', ...scope(f) })

    const restored = await f.files.restore({ path: '/project/a.md', version: 1, toPath: '/project/a-v1.md', ...scope(f) })
    expect(restored).toMatchObject({ ok: true })
    if (restored.ok) expect(restored.value).toMatchObject({ path: '/project/a-v1.md', version: 1, restoredFrom: 1 })

    const copy = await f.files.read({ path: '/project/a-v1.md', ...scope(f) })
    const current = await f.files.read({ path: '/project/a.md', ...scope(f) })
    expect(copy.ok && copy.value.content).toContain('original')
    expect(current.ok && current.value.content).toContain('overwritten')
  })

  it('refuses to restore onto a name that is taken', async () => {
    await f.files.write({ path: '/project/a.md', content: 'one', ...scope(f) })
    await f.files.write({ path: '/project/a.md', content: 'two', ...scope(f) })
    await f.files.write({ path: '/project/taken.md', content: 'mine', ...scope(f) })

    // Restoring must never destroy anything; that is the whole reason it insists on a free name.
    const clash = await f.files.restore({ path: '/project/a.md', version: 1, toPath: '/project/taken.md', ...scope(f) })
    expect(clash).toMatchObject({ ok: false, error: 'FILE_ALREADY_EXISTS' })

    const ontoSelf = await f.files.restore({ path: '/project/a.md', version: 1, toPath: '/project/a.md', ...scope(f) })
    expect(ontoSelf).toMatchObject({ ok: false, error: 'FILE_ALREADY_EXISTS' })
  })

  it('reports a version that never existed', async () => {
    await f.files.write({ path: '/project/a.md', content: 'one', ...scope(f) })
    const missing = await f.files.restore({ path: '/project/a.md', version: 7, toPath: '/project/b.md', ...scope(f) })
    expect(missing).toMatchObject({ ok: false, error: 'VERSION_NOT_FOUND' })
  })

  it('costs no extra storage to restore, because the bytes already exist', async () => {
    await f.files.write({ path: '/project/a.md', content: 'original', ...scope(f) })
    await f.files.write({ path: '/project/a.md', content: 'overwritten', ...scope(f) })
    const before = await f.db.select().from(attachments).where(eq(attachments.user_id, 1))

    await f.files.restore({ path: '/project/a.md', version: 1, toPath: '/project/a-v1.md', ...scope(f) })
    const after = await f.db.select().from(attachments).where(eq(attachments.user_id, 1))
    expect(after.length).toBe(before.length)
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
