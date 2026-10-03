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
  // Object storage below is per-fixture while D1 is not, and published bytes dedupe by hash: a
  // surviving attachment row would hand this test an id whose bytes live in the previous test's
  // store, and every read of them would come back empty.
  await db.delete(attachments)
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
    delete: async (key) => { objects.delete(key) },
    getBytes: async (key) => {
      const bytes = objects.get(key)
      return bytes ? { bytes } : null
    },
  }
  const files = new WorkspaceFiles(db, storage, 1)
  return { db, files, projectId: project!.id, conversationId: conversation!.id }
}

const scope = (f: Fixture) => ({ conversationId: f.conversationId, projectId: f.projectId, memory: false })

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

  it('answers two edits racing on one file with one success and one conflict, never a throw', async () => {
    await f.files.write({ path: '/project/a.md', content: 'alpha\nbeta', ...scope(f) })
    // Both read version 1 and both try to become version 2; the loser must not surface as a failure
    // of the tool itself, which would leave its call without a result.
    const results = await Promise.all([
      f.files.edit({ path: '/project/a.md', oldText: 'alpha', newText: 'ALPHA', ...scope(f) }),
      f.files.edit({ path: '/project/a.md', oldText: 'beta', newText: 'BETA', ...scope(f) }),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toMatchObject({ ok: false, error: 'VERSION_CONFLICT' })
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

  it('replaces the one place the text appears, as a new version', async () => {
    await f.files.write({ path: '/project/a.ts', content: 'const PORT = 3000\nstart(PORT)', ...scope(f) })

    const edited = await f.files.edit({ path: '/project/a.ts', oldText: 'PORT = 3000', newText: 'PORT = 8080', ...scope(f) })
    expect(edited).toMatchObject({ ok: true })
    if (edited.ok) expect(edited.value).toMatchObject({ replacements: 1, version: 2, operation: 'updated' })

    const after = await f.files.read({ path: '/project/a.ts', ...scope(f) })
    expect(after.ok && after.value.content).toContain('const PORT = 8080')
  })

  it('refuses an edit whose text appears more than once, rather than guessing', async () => {
    await f.files.write({ path: '/project/a.ts', content: 'log()\nlog()', ...scope(f) })

    // Editing the first of several is the one outcome nobody can review: it looks like it worked.
    const edited = await f.files.edit({ path: '/project/a.ts', oldText: 'log()', newText: 'debug()', ...scope(f) })
    expect(edited).toMatchObject({ ok: false, error: 'AMBIGUOUS_MATCH' })

    const after = await f.files.readBytes('project', scope(f), 'a.ts')
    expect(after.ok && new TextDecoder().decode(after.value.bytes)).toBe('log()\nlog()')
  })

  it('replaces every occurrence when asked to', async () => {
    const seeded = await f.files.write({ path: '/project/a.ts', content: 'log()\nlog()', ...scope(f) })
    expect(seeded).toMatchObject({ ok: true })

    const edited = await f.files.edit({ path: '/project/a.ts', oldText: 'log()', newText: 'debug()', replaceAll: true, ...scope(f) })
    expect(edited.ok && edited.value.replacements).toBe(2)

    const after = await f.files.readBytes('project', scope(f), 'a.ts')
    expect(after.ok && new TextDecoder().decode(after.value.bytes)).toBe('debug()\ndebug()')
  })

  it('reports text that is not there instead of writing an unchanged version', async () => {
    await f.files.write({ path: '/project/a.ts', content: 'one', ...scope(f) })

    const edited = await f.files.edit({ path: '/project/a.ts', oldText: 'two', newText: 'three', ...scope(f) })
    expect(edited).toMatchObject({ ok: false, error: 'NO_MATCH' })

    const after = await f.files.read({ path: '/project/a.ts', ...scope(f) })
    expect(after.ok && after.value.version).toBe(1)
  })

  it('treats $& in the replacement as literal text', async () => {
    await f.files.write({ path: '/project/a.ts', content: 'cost: 100', ...scope(f) })

    // String.replace reads $&, $1 and friends in the replacement. A model writing a price or a
    // regex into a file must not have it silently expanded into the text it matched.
    const edited = await f.files.edit({ path: '/project/a.ts', oldText: '100', newText: '$& $1 $$', ...scope(f) })
    expect(edited).toMatchObject({ ok: true })

    const after = await f.files.readBytes('project', scope(f), 'a.ts')
    expect(after.ok && new TextDecoder().decode(after.value.bytes)).toBe('cost: $& $1 $$')
  })

  it('matches text whose quotes are typed the other way', async () => {
    await f.files.write({ path: '/project/q.ts', content: 'const greeting = \u2018hello\u2019\nsay(greeting)', ...scope(f) })

    // A model reproducing code from a page, a chat log or its own memory routinely straightens
    // curly quotes. Failing here costs a whole round trip to be told the file still says what the
    // caller just read.
    const edited = await f.files.edit({ path: '/project/q.ts', oldText: "const greeting = 'hello'", newText: "const greeting = 'bye'", ...scope(f) })
    expect(edited).toMatchObject({ ok: true })

    const after = await f.files.readBytes('project', scope(f), 'q.ts')
    expect(after.ok && new TextDecoder().decode(after.value.bytes)).toBe("const greeting = 'bye'\nsay(greeting)")
  })

  it('counts a quote-insensitive match as a match when deciding it is ambiguous', async () => {
    await f.files.write({ path: '/project/q.ts', content: 'say(\u2018hi\u2019)\nsay(\'hi\')', ...scope(f) })

    // The two lines differ only in typography. Replacing the first silently would be exactly the
    // outcome the uniqueness rule exists to prevent.
    const edited = await f.files.edit({ path: '/project/q.ts', oldText: "say('hi')", newText: 'say("hi")', ...scope(f) })
    expect(edited).toMatchObject({ ok: false, error: 'AMBIGUOUS_MATCH' })
  })

  it('refuses an edit computed against a version that is no longer current', async () => {
    await f.files.write({ path: '/project/guard.ts', content: 'alpha', ...scope(f) })
    await f.files.write({ path: '/project/guard.ts', content: 'alpha and beta', ...scope(f) })

    // The caller read v1 and is patching what it saw there. v2 may have rewritten the very text it
    // names, so applying the patch to v2 would edit something the caller never looked at.
    const stale = await f.files.edit({ path: '/project/guard.ts', oldText: 'alpha', newText: 'gamma', expectedVersion: 1, ...scope(f) })
    expect(stale).toMatchObject({ ok: false, error: 'VERSION_CONFLICT' })

    const fresh = await f.files.edit({ path: '/project/guard.ts', oldText: 'alpha', newText: 'gamma', expectedVersion: 2, ...scope(f) })
    expect(fresh).toMatchObject({ ok: true })
  })

  it('cannot edit a file that does not exist', async () => {
    const edited = await f.files.edit({ path: '/project/missing.ts', oldText: 'a', newText: 'b', ...scope(f) })
    expect(edited).toMatchObject({ ok: false, error: 'FILE_NOT_FOUND' })
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
    await f.files.write({ path: '/conversation/notes.md', content: 'a\nb\nc\nd', conversationId: f.conversationId, projectId: null, memory: false })
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
    const result = await f.files.write({ path: '/project/x.md', content: 'x', conversationId: f.conversationId, projectId: null, memory: false })
    expect(result).toMatchObject({ ok: false, error: 'MOUNT_UNAVAILABLE' })
  })

  it('lists every mount at the root with its availability', async () => {
    const listed = await f.files.list({ path: '/', conversationId: f.conversationId, projectId: null, memory: false })
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

  it('renames a file, keeping its history and freeing the old name', async () => {
    // Content unique to this test: attachments dedupe by hash and outlive one fixture's storage.
    await f.files.write({ path: '/conversation/draft.md', content: 'draft one', ...scope(f) })
    await f.files.write({ path: '/conversation/draft.md', content: 'draft two', ...scope(f) })

    const renamed = await f.files.rename({ path: '/conversation/draft.md', toPath: '/conversation/final.md', ...scope(f) })
    expect(renamed).toMatchObject({ ok: true })
    if (renamed.ok) expect(renamed.value.moved).toEqual(['/conversation/final.md'])

    const read = await f.files.read({ path: '/conversation/final.md', ...scope(f) })
    expect(read.ok && read.value.version).toBe(2)
    // The old name is free, and the history came along rather than being left behind.
    const restored = await f.files.restore({ path: '/conversation/final.md', version: 1, toPath: '/conversation/draft.md', ...scope(f) })
    expect(restored.ok && restored.value.path).toBe('/conversation/draft.md')
  })

  it('refuses a rename onto a name in use, and a move into itself', async () => {
    await f.files.write({ path: '/conversation/a.md', content: 'a', ...scope(f) })
    await f.files.write({ path: '/conversation/b.md', content: 'b', ...scope(f) })

    expect(await f.files.rename({ path: '/conversation/a.md', toPath: '/conversation/b.md', ...scope(f) }))
      .toMatchObject({ ok: false, error: 'FILE_ALREADY_EXISTS' })
    expect(await f.files.rename({ path: '/conversation/site', toPath: '/conversation/site/inner', recursive: true, ...scope(f) }))
      .toMatchObject({ ok: false, error: 'INVALID_PATH' })
  })

  it('moves a directory in one call, keeping the layout inside it', async () => {
    await f.files.write({ path: '/conversation/site/index.html', content: '<link href="./css/x.css">', ...scope(f) })
    await f.files.write({ path: '/conversation/site/css/x.css', content: 'body{}', ...scope(f) })
    await f.files.write({ path: '/conversation/other.md', content: 'untouched', ...scope(f) })

    // Without recursive the path names nothing, and saying so is better than a puzzling not-found.
    expect(await f.files.rename({ path: '/conversation/site', toPath: '/project/site', ...scope(f) }))
      .toMatchObject({ ok: false, error: 'IS_DIRECTORY' })

    const moved = await f.files.rename({ path: '/conversation/site', toPath: '/project/site', recursive: true, ...scope(f) })
    expect(moved.ok && moved.value.moved).toEqual(['/project/site/css/x.css', '/project/site/index.html'])
    // A relative reference still resolves because the layout below the folder is unchanged.
    expect((await f.files.read({ path: '/project/site/css/x.css', ...scope(f) })).ok).toBe(true)
    expect((await f.files.read({ path: '/conversation/other.md', ...scope(f) })).ok).toBe(true)
  })

  it('deletes a file or a whole directory into the trash, freeing the names', async () => {
    await f.files.write({ path: '/conversation/site/index.html', content: 'page', ...scope(f) })
    await f.files.write({ path: '/conversation/site/app.js', content: 'js', ...scope(f) })
    await f.files.write({ path: '/conversation/keep.md', content: 'keep', ...scope(f) })

    expect(await f.files.deleteByPath({ path: '/conversation/site', ...scope(f) }))
      .toMatchObject({ ok: false, error: 'IS_DIRECTORY' })
    const removed = await f.files.deleteByPath({ path: '/conversation/site', recursive: true, ...scope(f) })
    expect(removed.ok && removed.value.deleted).toEqual(['/conversation/site/app.js', '/conversation/site/index.html'])

    expect(await f.files.read({ path: '/conversation/site/index.html', ...scope(f) })).toMatchObject({ ok: false, error: 'FILE_NOT_FOUND' })
    expect((await f.files.read({ path: '/conversation/keep.md', ...scope(f) })).ok).toBe(true)
    // The name is free again: deletion only hides the row, and the index only covers live ones.
    expect(await f.files.write({ path: '/conversation/site/index.html', content: 'new page', ...scope(f) }))
      .toMatchObject({ ok: true })
  })
})
