import { env } from 'cloudflare:workers'
import { unzipSync } from 'fflate'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { attachments, conversations, messages, pluginConfigs, projects, users, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { sweepTrash, TRASH_RETENTION_MS, WorkspaceFiles, type WorkspaceStorage } from '@/server/plugins/workspace-files/service'
import { ensureTestUser, workerFetch, type AuthTestClient } from './auth-helper'

/** Plugin routes live under the plugin's own id; core resources keep `/api`. */
const API = '/api/plugins/workspace_files'

interface Fixture {
  db: DB
  client: AuthTestClient
  projectId: number
  conversationId: number
  fileId: number
  storage: WorkspaceStorage
}

/**
 * The real bucket, not an in-memory stand-in: the routes under test read through the Worker's own
 * Assets service, so a fixture that wrote somewhere else would be invisible to them.
 */
const storage: WorkspaceStorage = {
  put: async (key, bytes, mime) => { await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } }) },
  delete: async (key) => { await env.BUCKET.delete(key) },
  getBytes: async (key) => {
    const object = await env.BUCKET.get(key)
    return object ? { bytes: new Uint8Array(await object.arrayBuffer()) } : null
  },
}

/** The rendered preview is opt-in; tests that want it say so. */
async function enableHtmlPreview(db: DB) {
  await db.delete(pluginConfigs)
  await db.insert(pluginConfigs).values({
    user_id: 1, plugin_id: 'workspace_files', key: 'html_preview', value: 'true', updated_at: Date.now(),
  })
}

async function fixture(): Promise<Fixture> {
  const db = createDb(env.DB)
  const client = await ensureTestUser(db)
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

  const files = new WorkspaceFiles(db, storage, 1)
  await files.write({ path: '/project/report.md', content: '# Report\nBody', conversationId: conversation!.id, projectId: project!.id, memory: false })
  const [row] = await db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'report.md'))
  return { db, client, projectId: project!.id, conversationId: conversation!.id, fileId: row!.id, storage }
}

describe('workspace files REST', () => {
  let f: Fixture
  beforeEach(async () => { f = await fixture() })

  it('lists a project mount with the metadata the panel shows', async () => {
    const response = await f.client.request(`${API}/projects/${f.projectId}/files`, { method: 'GET' })
    expect(response.status).toBe(200)
    const body = await response.json() as { files: Array<Record<string, unknown>> }
    expect(body.files).toHaveLength(1)
    expect(body.files[0]).toMatchObject({
      path: '/project/report.md', fileSize: 13, totalLines: 2, version: 1,
    })
  })

  it('shows a conversation its own files and the project files it can also reach', async () => {
    const response = await f.client.request(`${API}/conversations/${f.conversationId}/files`, { method: 'GET' })
    const body = await response.json() as { files: unknown[], projectFiles: Array<{ path: string }> }
    expect(body.files).toEqual([])
    expect(body.projectFiles.map(file => file.path)).toEqual(['/project/report.md'])
  })

  it('serves a binary file as its bytes and type, never as decoded text', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0xff, 0xfe])
    const key = `panel-binary/${crypto.randomUUID()}`
    await env.BUCKET.put(key, bytes)
    const [image] = await f.db.insert(attachments).values({ user_id: 1, sha256: crypto.randomUUID(), mime: 'image/png', size: bytes.byteLength, r2_key: key, origin: 'upload', created_at: 0 }).returning()
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.copy({ from: { attachment: { attachmentId: image!.id, mime: 'image/png', size: bytes.byteLength } }, toPath: '/project/cat.png', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    const [row] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'cat.png'))

    expect(await (await f.client.request(`${API}/files/${row!.id}`)).json()).toMatchObject({
      content: null, mime: 'image/png', attachmentId: image!.id, record: { path: '/project/cat.png', mime: 'image/png', totalLines: 0 },
    })
    const download = await f.client.request(`${API}/files/${row!.id}/download`)
    expect(download.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
  })

  it('returns the current content for preview', async () => {
    const response = await f.client.request(`${API}/files/${f.fileId}`, { method: 'GET' })
    const body = await response.json() as { content: string, record: { version: number } }
    expect(body.content).toBe('# Report\nBody')
    expect(body.record.version).toBe(1)
  })

  it('serves a download as an attachment that browsers will not render', async () => {
    const response = await f.client.request(`${API}/files/${f.fileId}/download`, { method: 'GET' })
    expect(response.status).toBe(200)
    // Model-written content must never be handed to a browser as a page to execute.
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('# Report\nBody')
  })

  it('hides a deleted file while leaving its versions in place', async () => {
    expect((await f.client.request(`${API}/files/${f.fileId}`, { method: 'DELETE' })).status).toBe(204)

    const listed = await (await f.client.request(`${API}/projects/${f.projectId}/files`, { method: 'GET' })).json() as { files: unknown[] }
    expect(listed.files).toEqual([])
    // The bytes stay addressable until attachment cleanup can reclaim them.
    const versions = await f.db.select().from(workspaceFileVersions).where(eq(workspaceFileVersions.file_id, f.fileId))
    expect(versions).toHaveLength(1)
    expect((await f.client.request(`${API}/files/${f.fileId}`, { method: 'GET' })).status).toBe(404)
  })

  it('frees the path once the file is deleted', async () => {
    await f.client.request(`${API}/files/${f.fileId}`, { method: 'DELETE' })
    const files = new WorkspaceFiles(f.db, f.storage, 1)
    const again = await files.write({ path: '/project/report.md', content: 'new one', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    expect(again).toMatchObject({ ok: true })
    if (again.ok) expect(again.value).toMatchObject({ operation: 'created', version: 1 })
  })

  it('packs a mount into one archive so a page keeps the files it references', async () => {
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/site/index.html', content: '<link href="./style.css">', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    await files.write({ path: '/project/site/style.css', content: 'body{}', conversationId: f.conversationId, projectId: f.projectId, memory: false })

    const response = await f.client.request(`${API}/projects/${f.projectId}/files/archive`, { method: 'GET' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const archive = new Uint8Array(await response.arrayBuffer())
    const entries = unzipSync(archive)
    // Relative layout is the whole point: unzipped, the page finds its stylesheet where it looks.
    expect(Object.keys(entries).sort()).toEqual(['report.md', 'site/index.html', 'site/style.css'])
    expect(new TextDecoder().decode(entries['site/style.css'])).toBe('body{}')

    // One folder on its own, for taking just the page that was asked about.
    const folder = await f.client.request(`${API}/projects/${f.projectId}/files/archive?prefix=site/`, { method: 'GET' })
    expect(Object.keys(unzipSync(new Uint8Array(await folder.arrayBuffer()))).sort())
      .toEqual(['site/index.html', 'site/style.css'])
    expect((await f.client.request(`${API}/projects/${f.projectId}/files/archive?prefix=../etc`, { method: 'GET' })).status).toBe(400)
  })

  it('puts a plugin route behind the session guard without the plugin asking', async () => {
    // The guard is mounted before any plugin registers, so being under /api/plugins is enough.
    expect((await workerFetch(`${API}/projects/${f.projectId}/files`)).status).toBe(401)
  })

  it('serves a file as text until the plugin setting asks for a page', async () => {
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/page.html', content: '<h1>hi</h1>', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    const [row] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'page.html'))

    const body = await (await f.client.request(`${API}/files/${row!.id}`, { method: 'GET' })).json() as { previewUrl: string, canRenderPage: boolean }
    expect(body.canRenderPage).toBe(false)
    // Looking at a file is always allowed; a browser shows text rather than running it.
    const page = await workerFetch(body.previewUrl)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/plain')
    // Guessing a ticket is not a way in either.
    expect((await workerFetch(`${API}/preview/${'0'.repeat(32)}/report.md`)).status).toBe(404)
  })

  it('serves a page and the files it references under one ticket', async () => {
    await enableHtmlPreview(f.db)
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/site/index.html', content: '<link href="./style.css">', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    await files.write({ path: '/project/site/style.css', content: 'body{}', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    const [row] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'site/index.html'))

    const body = await (await f.client.request(`${API}/files/${row!.id}`, { method: 'GET' })).json() as { previewUrl: string, canRenderPage: boolean }
    expect(body.canRenderPage).toBe(true)
    expect(body.previewUrl).toMatch(/^\/api\/plugins\/workspace_files\/preview\/[0-9a-f]{32}\/site\/index\.html$/)

    // No cookie: a sandboxed frame has an opaque origin and sends none. The ticket in the path is
    // the credential, and the relative sibling it resolves to must arrive the same way.
    const page = await workerFetch(body.previewUrl)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain('sandbox')

    const sibling = await workerFetch(body.previewUrl.replace('index.html', 'style.css'))
    expect(sibling.status).toBe(200)
    expect(sibling.headers.get('content-type')).toContain('text/css')
    expect(await sibling.text()).toBe('body{}')
  })

  it('lets the page fetch its own data files, whose requests come from an opaque origin', async () => {
    await enableHtmlPreview(f.db)
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/chart/index.html', content: '<script>fetch("./cars.csv")</script>', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    await files.write({ path: '/project/chart/cars.csv', content: 'a,b\n1,2\n', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    const [row] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'chart/index.html'))
    const body = await (await f.client.request(`${API}/files/${row!.id}`, { method: 'GET' })).json() as { previewUrl: string }
    const csvUrl = body.previewUrl.replace('index.html', 'cars.csv')

    const data = await workerFetch(csvUrl, { headers: { origin: 'null' } })
    expect(data.status).toBe(200)
    expect(data.headers.get('access-control-allow-origin')).toBe('*')

    // A missing file must reach the page as a 404 it can read, not as an opaque CORS failure.
    const missing = await workerFetch(body.previewUrl.replace('index.html', 'nope.csv'), { headers: { origin: 'null' } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('stops serving a page as a page the moment the setting goes back off', async () => {
    await enableHtmlPreview(f.db)
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/page.html', content: '<h1>hi</h1>', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    const [row] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'page.html'))
    const body = await (await f.client.request(`${API}/files/${row!.id}`, { method: 'GET' })).json() as { previewUrl: string }
    expect((await workerFetch(body.previewUrl)).headers.get('content-type')).toContain('text/html')

    // The ticket outlives the setting, so the setting is what each request asks — not the ticket.
    await f.db.delete(pluginConfigs)
    expect((await workerFetch(body.previewUrl)).headers.get('content-type')).toContain('text/plain')
  })

  it('keeps a deleted file recoverable, then destroys it for good', async () => {
    const [version] = await f.db.select().from(workspaceFileVersions).where(eq(workspaceFileVersions.file_id, f.fileId))
    const [attachment] = await f.db.select().from(attachments).where(eq(attachments.id, version!.attachment_id))
    expect(await env.BUCKET.head(attachment!.r2_key)).not.toBeNull()

    await f.client.request(`${API}/files/${f.fileId}`, { method: 'DELETE' })
    const trashed = await (await f.client.request(`${API}/trash`, { method: 'GET' })).json() as { files: Array<{ id: number, relativePath: string }>, scopes: { projects: Record<string, string> } }
    expect(trashed.files.map(file => file.relativePath)).toEqual(['report.md'])
    // The list spans every scope, so it says which Project or conversation each file came from.
    expect(trashed.scopes.projects[String(f.projectId)]).toBe('p')

    expect((await f.client.request(`${API}/trash/${f.fileId}/restore`, { method: 'POST' })).status).toBe(200)
    const listed = await (await f.client.request(`${API}/projects/${f.projectId}/files`, { method: 'GET' })).json() as { files: unknown[] }
    expect(listed.files).toHaveLength(1)

    await f.client.request(`${API}/files/${f.fileId}`, { method: 'DELETE' })
    const purged = await (await f.client.request(`${API}/trash`, { method: 'DELETE' })).json() as { files: number, bytes: number }
    expect(purged).toMatchObject({ files: 1, bytes: 13 })
    // Purge is the one thing that reclaims bytes; nothing else in the app removes an R2 object.
    expect(await env.BUCKET.head(attachment!.r2_key)).toBeNull()
    expect(await f.db.select().from(workspaceFileVersions).where(eq(workspaceFileVersions.file_id, f.fileId))).toHaveLength(0)
  })

  it('refuses to restore onto a name that was taken meanwhile', async () => {
    await f.client.request(`${API}/files/${f.fileId}`, { method: 'DELETE' })
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/report.md', content: 'a different one', conversationId: f.conversationId, projectId: f.projectId, memory: false })

    const response = await f.client.request(`${API}/trash/${f.fileId}/restore`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'FILE_ALREADY_EXISTS' })
  })

  it('keeps bytes a live file still shares, and sweeps only what nobody came back for', async () => {
    // Same content, so both versions address one attachment: purging one must not blind the other.
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/copy.md', content: '# Report\nBody', conversationId: f.conversationId, projectId: f.projectId, memory: false })
    const [copy] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'copy.md'))
    const [version] = await f.db.select().from(workspaceFileVersions).where(eq(workspaceFileVersions.file_id, copy!.id))
    const [attachment] = await f.db.select().from(attachments).where(eq(attachments.id, version!.attachment_id))

    await f.client.request(`${API}/files/${copy!.id}`, { method: 'DELETE' })
    const purged = await (await f.client.request(`${API}/trash`, { method: 'DELETE' })).json() as { files: number, bytes: number }
    expect(purged).toMatchObject({ files: 1, bytes: 0 })
    expect(await env.BUCKET.head(attachment!.r2_key)).not.toBeNull()

    // The sweep destroys what has sat in the trash past its retention, and nothing younger.
    await f.client.request(`${API}/files/${f.fileId}`, { method: 'DELETE' })
    expect(await sweepTrash(f.db, storage, Date.now())).toMatchObject({ files: 0 })
    expect(await sweepTrash(f.db, storage, Date.now() + TRASH_RETENTION_MS + 1)).toMatchObject({ files: 1, bytes: 13 })
    expect(await env.BUCKET.head(attachment!.r2_key)).toBeNull()
  })

  it('never reveals a file belonging to another tenant', async () => {
    const db = createDb(env.DB)
    const [other] = await db.insert(users).values({
      name: 'other', settings: { plugins: {} }, createdAt: new Date(0), updatedAt: new Date(0),
      email: `${crypto.randomUUID()}@example.com`,
    }).returning()
    const [otherProject] = await db.insert(projects).values({
      user_id: other!.id, name: 'theirs', icon_attachment_id: null, system_prompt: null,
      provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0,
    }).returning()

    // A 404 rather than a 403: the existence of another tenant's row is itself private.
    expect((await f.client.request(`${API}/projects/${otherProject!.id}/files`, { method: 'GET' })).status).toBe(404)
  })
})
