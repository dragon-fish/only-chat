import { env } from 'cloudflare:workers'
import { unzipSync } from 'fflate'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { conversations, pluginConfigs, projects, users, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { WorkspaceFiles, type WorkspaceStorage } from '@/server/plugins/workspace-files/service'
import { ensureTestUser, workerFetch, type AuthTestClient } from './auth-helper'

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
  await files.write({ path: '/project/report.md', content: '# Report\nBody', conversationId: conversation!.id, projectId: project!.id })
  const [row] = await db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'report.md'))
  return { db, client, projectId: project!.id, conversationId: conversation!.id, fileId: row!.id, storage }
}

describe('workspace files REST', () => {
  let f: Fixture
  beforeEach(async () => { f = await fixture() })

  it('lists a project mount with the metadata the panel shows', async () => {
    const response = await f.client.request(`/api/projects/${f.projectId}/files`, { method: 'GET' })
    expect(response.status).toBe(200)
    const body = await response.json() as { files: Array<Record<string, unknown>> }
    expect(body.files).toHaveLength(1)
    expect(body.files[0]).toMatchObject({
      path: '/project/report.md', fileSize: 13, totalLines: 2, version: 1,
    })
  })

  it('shows a conversation its own files and the project files it can also reach', async () => {
    const response = await f.client.request(`/api/conversations/${f.conversationId}/files`, { method: 'GET' })
    const body = await response.json() as { files: unknown[], projectFiles: Array<{ path: string }> }
    expect(body.files).toEqual([])
    expect(body.projectFiles.map(file => file.path)).toEqual(['/project/report.md'])
  })

  it('returns the current content for preview', async () => {
    const response = await f.client.request(`/api/workspace-files/${f.fileId}`, { method: 'GET' })
    const body = await response.json() as { content: string, record: { version: number } }
    expect(body.content).toBe('# Report\nBody')
    expect(body.record.version).toBe(1)
  })

  it('serves a download as an attachment that browsers will not render', async () => {
    const response = await f.client.request(`/api/workspace-files/${f.fileId}/download`, { method: 'GET' })
    expect(response.status).toBe(200)
    // Model-written content must never be handed to a browser as a page to execute.
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.headers.get('content-disposition')).toContain('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('# Report\nBody')
  })

  it('hides a deleted file while leaving its versions in place', async () => {
    expect((await f.client.request(`/api/workspace-files/${f.fileId}`, { method: 'DELETE' })).status).toBe(204)

    const listed = await (await f.client.request(`/api/projects/${f.projectId}/files`, { method: 'GET' })).json() as { files: unknown[] }
    expect(listed.files).toEqual([])
    // The bytes stay addressable until attachment cleanup can reclaim them.
    const versions = await f.db.select().from(workspaceFileVersions).where(eq(workspaceFileVersions.file_id, f.fileId))
    expect(versions).toHaveLength(1)
    expect((await f.client.request(`/api/workspace-files/${f.fileId}`, { method: 'GET' })).status).toBe(404)
  })

  it('frees the path once the file is deleted', async () => {
    await f.client.request(`/api/workspace-files/${f.fileId}`, { method: 'DELETE' })
    const files = new WorkspaceFiles(f.db, f.storage, 1)
    const again = await files.write({ path: '/project/report.md', content: 'new one', conversationId: f.conversationId, projectId: f.projectId })
    expect(again).toMatchObject({ ok: true })
    if (again.ok) expect(again.value).toMatchObject({ operation: 'created', version: 1 })
  })

  it('packs a mount into one archive so a page keeps the files it references', async () => {
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/site/index.html', content: '<link href="./style.css">', conversationId: f.conversationId, projectId: f.projectId })
    await files.write({ path: '/project/site/style.css', content: 'body{}', conversationId: f.conversationId, projectId: f.projectId })

    const response = await f.client.request(`/api/projects/${f.projectId}/files/archive`, { method: 'GET' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const archive = new Uint8Array(await response.arrayBuffer())
    const entries = unzipSync(archive)
    // Relative layout is the whole point: unzipped, the page finds its stylesheet where it looks.
    expect(Object.keys(entries).sort()).toEqual(['report.md', 'site/index.html', 'site/style.css'])
    expect(new TextDecoder().decode(entries['site/style.css'])).toBe('body{}')

    // One folder on its own, for taking just the page that was asked about.
    const folder = await f.client.request(`/api/projects/${f.projectId}/files/archive?prefix=site/`, { method: 'GET' })
    expect(Object.keys(unzipSync(new Uint8Array(await folder.arrayBuffer()))).sort())
      .toEqual(['site/index.html', 'site/style.css'])
    expect((await f.client.request(`/api/projects/${f.projectId}/files/archive?prefix=../etc`, { method: 'GET' })).status).toBe(400)
  })

  it('offers no rendered preview until the plugin setting asks for one', async () => {
    const body = await (await f.client.request(`/api/workspace-files/${f.fileId}`, { method: 'GET' })).json() as { previewUrl: string | null }
    expect(body.previewUrl).toBeNull()
    // Guessing a ticket is not a way in either.
    expect((await f.client.request(`/api/workspace-preview/${'0'.repeat(32)}/report.md`, { method: 'GET' })).status).toBe(404)
  })

  it('serves a page and the files it references under one ticket', async () => {
    await enableHtmlPreview(f.db)
    const files = new WorkspaceFiles(f.db, storage, 1)
    await files.write({ path: '/project/site/index.html', content: '<link href="./style.css">', conversationId: f.conversationId, projectId: f.projectId })
    await files.write({ path: '/project/site/style.css', content: 'body{}', conversationId: f.conversationId, projectId: f.projectId })
    const [row] = await f.db.select().from(workspaceFiles).where(eq(workspaceFiles.relative_path, 'site/index.html'))

    const body = await (await f.client.request(`/api/workspace-files/${row!.id}`, { method: 'GET' })).json() as { previewUrl: string }
    expect(body.previewUrl).toMatch(/^\/api\/workspace-preview\/[0-9a-f]{32}\/site\/index\.html$/)

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

  it('stops serving a preview the moment the setting goes back off', async () => {
    await enableHtmlPreview(f.db)
    const body = await (await f.client.request(`/api/workspace-files/${f.fileId}`, { method: 'GET' })).json() as { previewUrl: string }
    await f.db.delete(pluginConfigs)
    expect((await workerFetch(body.previewUrl)).status).toBe(404)
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
    expect((await f.client.request(`/api/projects/${otherProject!.id}/files`, { method: 'GET' })).status).toBe(404)
  })
})
