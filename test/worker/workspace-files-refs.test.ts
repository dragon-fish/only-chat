import { env } from 'cloudflare:workers'
import { Context } from 'cordis'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Tool } from 'ai'
import { createDb, type DB } from '@/server/db/client'
import { attachments, conversations, messages, projects, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { ToolRegistry, type ToolContext } from '@/server/plugins/tools'
import type { GenerationTurn } from '@/server/plugins/hub/generation-turn'
import { FileReaderServerPlugin } from '@/plugins/file-reader/server'
import { WorkspaceFiles } from '@/server/plugins/workspace-files/service'
import { WorkspaceFilesServerPlugin } from '@/plugins/workspace-files/server'
import manifest from '@/plugins/workspace-files/manifest'
import { pluginToolIds, READ_FILE_TOOL_ID } from '@/shared/plugins'
import type { Part } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'

const WORKSPACE_TOOLS = [READ_FILE_TOOL_ID, ...pluginToolIds(manifest)]
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])

interface Fixture {
  db: DB
  ctx: Context
  tools: Record<string, Tool>
  runtime: ToolContext
  files: WorkspaceFiles
  upload: { id: number, ref: string }
  projectId: number
  conversationId: number
}

/**
 * Tools run directly against a real D1, with a conversation whose one user message holds an upload
 * — the asset every `asset:` case below refers to.
 */
async function fixture(toolIds: readonly string[] = WORKSPACE_TOOLS, extraParts: Part[] = []): Promise<Fixture> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  const [project] = await db.insert(projects).values({
    user_id: 1, name: 'p', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0,
  }).returning()
  const [conversation] = await db.insert(conversations).values({
    user_id: 1, project_id: project!.id, title: 'c', head_message_id: null, provider_id: null,
    model_id: null, system_prompt: null, params: null, tools: [], created_at: 0, updated_at: 0,
  }).returning()

  const objects = new Map<string, Uint8Array>()
  const storage = {
    put: async (key: string, bytes: Uint8Array | ArrayBuffer) => { objects.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) },
    getBytes: async (key: string) => (objects.has(key) ? { bytes: objects.get(key)! } : null),
    delete: async (key: string) => { objects.delete(key) },
  }
  const sha256 = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '').slice(0, 64)
  objects.set(`refs/${sha256}`, PNG)
  const [upload] = await db.insert(attachments).values({
    user_id: 1, sha256, mime: 'image/png', size: PNG.byteLength, width: 1, height: 1, r2_key: `refs/${sha256}`, origin: 'upload', created_at: 0,
  }).returning()
  const [user] = await db.insert(messages).values({
    conversation_id: conversation!.id, parent_id: null, seq: 0, role: 'user', parts: [{ type: 'image', attachment_id: upload!.id, filename: 'cat.png' }, ...extraParts],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  }).returning()
  const [assistant] = await db.insert(messages).values({
    conversation_id: conversation!.id, parent_id: user!.id, seq: 1, role: 'assistant', parts: [],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  }).returning()

  const ctx = new Context()
  ctx.provide('env', env)
  ctx.provide('pluginConfig', { readIfConfigurable: async () => ({}), read: async () => ({}) })
  ctx.provide('db', { orm: db })
  ctx.provide('assets', storage)
  const registry = new ToolRegistry(ctx)
  await ctx.plugin(FileReaderServerPlugin)
  await ctx.plugin(WorkspaceFilesServerPlugin)

  const path = [{ id: user!.id, conversation_id: conversation!.id, parent_id: null, seq: 0, role: 'user' as const, parts: user!.parts, provider_id: null, model_id: null, usage: null, status: 'done' as const, error: null, created_at: 0 }]
  // What the hub does at generation start: plugins prepare the turn their tools then run in.
  const turn: GenerationTurn = {
    userId: 1, conversationId: conversation!.id, projectId: project!.id, toolIds, path, state: new Map(),
    canReadFile: mime => mime.startsWith('image/'),
  }
  await ctx.parallel('generation/prepare', turn)
  const runtime: ToolContext = {
    userId: 1, conversationId: conversation!.id, projectId: project!.id, assistantMessageId: assistant!.id,
    config: {}, conversationConfig: {}, turn: turn.state, db, assets: storage as never,
    signal: new AbortController().signal, acceptsImages: true, acceptsToolResultImages: true,
    toolIds, canReadFile: turn.canReadFile, publicOrigin: 'https://chat.test', path,
  }
  const built = toolIds.length === 0 ? [] : await registry.resolve([...toolIds], { workspace_files: true }, { ...runtime, pluginSettings: null })
  return {
    db, ctx, runtime, tools: Object.fromEntries(built), files: new WorkspaceFiles(db, storage, 1),
    upload: { id: upload!.id, ref: `asset:${sha256.slice(0, 8)}` }, projectId: project!.id, conversationId: conversation!.id,
  }
}

/** A reference as another plugin's tool resolves it, through the file reader. */
const resolve = (f: Fixture, ref: string) => f.ctx.fileReader.resolve(f.ctx.fileReader.turnOf(f.runtime.turn), ref)

let calls = 0
const run = async (f: Fixture, name: string, input: unknown) =>
  (f.tools[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: `call-${++calls}`, messages: [] })

async function currentAttachment(f: Fixture, relativePath: string): Promise<number | undefined> {
  const [row] = await f.db.select({ attachmentId: workspaceFileVersions.attachment_id }).from(workspaceFiles)
    .innerJoin(workspaceFileVersions, and(eq(workspaceFileVersions.file_id, workspaceFiles.id), eq(workspaceFileVersions.version, workspaceFiles.current_version)))
    .where(and(eq(workspaceFiles.project_id, f.projectId), eq(workspaceFiles.relative_path, relativePath)))
  return row?.attachmentId
}

describe('workspace files and file references', () => {
  it('reads an asset: by delivering it, and never as text', async () => {
    const f = await fixture()
    expect(await run(f, 'read_file', { file: f.upload.ref })).toEqual({
      file: f.upload.ref, name: 'cat.png', mime: 'image/png', message: expect.any(String), __attachments: [f.upload.id],
    })
  })

  it('copies an asset into /project as a binary file sharing its bytes, readable by path or vfs:', async () => {
    const f = await fixture()
    expect(await run(f, 'copy_file', { from: f.upload.ref, to: '/project/refs/cat.png' })).toMatchObject({ path: '/project/refs/cat.png', fromName: 'cat.png', mime: 'image/png', version: 1 })
    expect(await currentAttachment(f, 'refs/cat.png')).toBe(f.upload.id)

    const byPath = await run(f, 'read_file', { file: '/project/refs/cat.png' })
    expect(byPath).toMatchObject({ file: f.upload.ref, __attachments: [f.upload.id] })
    expect(await run(f, 'read_file', { file: 'vfs:/project/refs/cat.png' })).toEqual(byPath)
    // The hook resolves the copy for any tool that takes a reference.
    expect(await resolve(f, 'vfs:/project/refs/cat.png')).toMatchObject({ ok: true, value: { attachmentId: f.upload.id, filename: 'cat.png' } })

    for (const tool of ['write_file', 'edit_file'] as const) {
      const input = tool === 'write_file' ? { path: '/project/refs/cat.png', content: 'x' } : { path: '/project/refs/cat.png', oldText: 'a', newText: 'b' }
      expect(await run(f, tool, input), tool).toMatchObject({ error: 'BINARY_FILE' })
    }
  })

  it('copies a workspace file named by vfs:, and treats a bare path and vfs: as the same file', async () => {
    const f = await fixture()
    expect(await run(f, 'write_file', { path: 'vfs:/conversation/notes.md', content: 'one\ntwo' })).toMatchObject({ path: '/conversation/notes.md' })
    expect(await run(f, 'copy_file', { from: 'vfs:/conversation/notes.md', to: '/project/notes.md' })).toMatchObject({ path: '/project/notes.md', version: 1 })
    expect(await run(f, 'read_file', { file: '/project/notes.md' })).toMatchObject({ path: '/project/notes.md', content: '1 | one\n2 | two', totalLines: 2 })
    expect(await run(f, 'copy_file', { from: '/conversation/notes.md', to: 'vfs:/project/notes.md' })).toMatchObject({ error: 'FILE_ALREADY_EXISTS' })
    // Text resolves as text, which read_file pages through; tools that want media refuse it themselves.
    expect(await resolve(f, 'vfs:/project/notes.md')).toMatchObject({ ok: true, value: { kind: 'text', ref: '/project/notes.md', mime: expect.stringMatching(/^text\//) } })
  })

  it('refuses to change an asset, and refuses one where only a workspace path makes sense', async () => {
    const f = await fixture()
    const ref = f.upload.ref
    for (const [tool, input] of [
      ['write_file', { path: ref, content: 'x' }],
      ['edit_file', { path: ref, oldText: 'a', newText: 'b' }],
      ['rename_file', { path: ref, toPath: '/project/x.png' }],
      ['rename_file', { path: '/project/x.png', toPath: ref }],
      ['delete_file', { path: ref }],
      ['copy_file', { from: '/project/x.png', to: ref }],
    ] as const) expect(await run(f, tool, input), tool).toMatchObject({ error: 'READ_ONLY', message: expect.stringContaining('copy_file') })
    for (const [tool, input] of [
      ['restore_file', { path: ref, version: 1, toPath: '/project/x.png' }],
      ['list_files', { path: ref }],
      ['preview_file', { path: ref }],
      ['write_file', { path: 'https://example.com/x.png', content: 'x' }],
    ] as const) expect(await run(f, tool, input), tool).toMatchObject({ error: 'INVALID_PATH' })
  })

  it('leaves vfs: unclaimed in a turn without workspace tools', async () => {
    const f = await fixture([READ_FILE_TOOL_ID])
    expect(await resolve(f, 'vfs:/project/refs/cat.png')).toMatchObject({ ok: false, error: 'UNSUPPORTED_SCHEME' })
  })

  it('keeps bytes that messages still reference when a copy is purged, and frees them otherwise', async () => {
    const referenced = (await fixture()).upload.id
    const f = await fixture(WORKSPACE_TOOLS, [
      { type: 'task_notification', task_id: 't', plugin_id: 'image_generation', tool_call_id: 'c', status: 'completed', text: '', attachments: [referenced] },
    ])
    // Only a tool result and a task notification point at `referenced`; nothing at all points at `lone` but the copy.
    await f.db.insert(messages).values({
      conversation_id: f.conversationId, parent_id: null, seq: 9, role: 'assistant',
      parts: [{ type: 'tool_result', call_id: 'x', name: 'read_file', content: {}, attachments: [referenced] }],
      provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
    })
    const [lone] = await f.db.insert(attachments).values({
      user_id: 1, sha256: (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '').slice(0, 64), mime: 'image/png', size: 1, r2_key: 'refs/lone', origin: 'upload', created_at: 0,
    }).returning()
    for (const [id, name] of [[f.upload.id, 'a.png'], [referenced, 'b.png'], [lone!.id, 'c.png']] as const) {
      expect(await f.files.copy({ from: { attachment: { attachmentId: id, mime: 'image/png', size: 1 } }, toPath: `/project/${name}`, conversationId: f.conversationId, projectId: f.projectId })).toMatchObject({ ok: true })
      await f.files.deleteByPath({ path: `/project/${name}`, conversationId: f.conversationId, projectId: f.projectId })
    }
    const trashed = await f.db.select({ id: workspaceFiles.id }).from(workspaceFiles).where(eq(workspaceFiles.project_id, f.projectId))
    await f.files.purge(trashed.map(row => row.id))
    const left = await f.db.select({ id: attachments.id }).from(attachments)
    expect(left.map(row => row.id)).toEqual(expect.arrayContaining([f.upload.id, referenced]))
    expect(left.map(row => row.id)).not.toContain(lone!.id)
  })
})
