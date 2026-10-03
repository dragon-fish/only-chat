import { env } from 'cloudflare:workers'
import { Context } from 'cordis'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from 'ai'
import { createDb, type DB } from '@/server/db/client'
import { attachments, conversations, memories, memorySnapshots, messages, projects, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { ToolRegistry, type ToolContext } from '@/server/plugins/tools'
import { PromptSections } from '@/server/plugins/prompt-sections'
import { WorkspaceFiles } from '@/server/plugins/workspace-files/service'
import { WorkspaceFilesServerPlugin } from '@/plugins/workspace-files/server'
import { FileReaderServerPlugin } from '@/plugins/file-reader/server'
import { MemoryServerPlugin } from '@/plugins/memory/server'
import { memoryPreamble } from '@/plugins/memory/server/catalog'
import type { GenerationTurn } from '@/server/plugins/hub/generation-turn'
import type { Message } from '@/shared/models'
import { ensureTestUser } from './auth-helper'

const MEMORY_TOOLS = ['memory_save', 'read_file', 'write_file', 'edit_file', 'list_files', 'delete_file', 'rename_file']

/**
 * Drives the plugins the way the hub does — `generation/prepare`, then tools built for that turn —
 * without a model, because what is under test is ordering a model cannot produce on demand.
 */
interface Harness {
  db: DB
  ctx: Context
  registry: ToolRegistry
  files: WorkspaceFiles
  projectId: number
  conversationId: number
  assistantId: number
  assets: { put: (key: string, bytes: Uint8Array | ArrayBuffer) => Promise<void>, delete: (key: string) => Promise<void>, getBytes: (key: string) => Promise<{ bytes: Uint8Array } | null> }
}

async function harness(): Promise<Harness> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  await db.delete(memorySnapshots)
  await db.delete(memories)
  await db.delete(workspaceFileVersions)
  await db.delete(workspaceFiles)
  // Bytes dedupe by hash per user while object storage below is per-harness: a surviving attachment
  // row would point this test at bytes that only the previous test's store holds.
  await db.delete(attachments)
  const [project] = await db.insert(projects).values({
    user_id: 1, name: 'p', icon_attachment_id: null, system_prompt: null,
    provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0,
  }).returning()
  const [conversation] = await db.insert(conversations).values({
    user_id: 1, project_id: project!.id, title: 'c', head_message_id: null, provider_id: null,
    model_id: null, system_prompt: null, params: null, tools: [], created_at: 0, updated_at: 0,
  }).returning()
  const [assistant] = await db.insert(messages).values({
    conversation_id: conversation!.id, parent_id: null, seq: 0, role: 'assistant', parts: [],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  }).returning()

  const objects = new Map<string, Uint8Array>()
  const assets = {
    put: async (key: string, bytes: Uint8Array | ArrayBuffer) => { objects.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) },
    delete: async (key: string) => { objects.delete(key) },
    getBytes: async (key: string) => {
      const bytes = objects.get(key)
      return bytes ? { bytes } : null
    },
  }
  const ctx = new Context()
  ctx.provide('env', env)
  ctx.provide('pluginConfig', { readIfConfigurable: async () => ({}), read: async () => ({}) })
  ctx.provide('db', { orm: db })
  ctx.provide('assets', assets)
  const registry = new ToolRegistry(ctx)
  new PromptSections(ctx)
  await ctx.plugin(FileReaderServerPlugin)
  await ctx.plugin(WorkspaceFilesServerPlugin)
  await ctx.plugin(MemoryServerPlugin)
  return {
    db, ctx, registry, files: new WorkspaceFiles(db, assets as never, 1),
    projectId: project!.id, conversationId: conversation!.id, assistantId: assistant!.id, assets,
  }
}

interface Turn {
  generation: GenerationTurn
  tools: Record<string, Tool>
}

async function startTurn(h: Harness, options: { toolIds?: string[], path?: Message[], projectId?: number | null, db?: DB } = {}): Promise<Turn> {
  const toolIds = options.toolIds ?? MEMORY_TOOLS
  const projectId = options.projectId === undefined ? h.projectId : options.projectId
  const generation: GenerationTurn = {
    userId: 1, conversationId: h.conversationId, projectId, toolIds,
    path: options.path ?? [], state: new Map(), canReadFile: () => false, notes: [],
  }
  await h.ctx.parallel('generation/prepare', generation)
  const runtime: ToolContext = {
    userId: 1, conversationId: h.conversationId, projectId, assistantMessageId: h.assistantId,
    config: {}, conversationConfig: {}, turn: generation.state, db: options.db ?? h.db, assets: h.assets as never,
    signal: new AbortController().signal, acceptsImages: false, toolIds, canReadFile: generation.canReadFile,
    acceptsToolResultImages: false, publicOrigin: 'https://chat.test', path: generation.path,
  }
  const built = await h.registry.resolve(toolIds, { workspace_files: true, file_reader: true, memory: true }, { ...runtime, pluginSettings: null })
  return { generation, tools: Object.fromEntries(built) }
}

const run = async (turn: Turn, name: string, input: unknown) =>
  (turn.tools[name]!.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, { toolCallId: `call-${name}`, messages: [] })

const save = (turn: Turn, input: Record<string, unknown>) => run(turn, 'memory_save', { description: 'd', ...input })

/** A finished assistant turn holding one tool call and its result, as a later turn's path sees it. */
function answered(name: string, args: unknown, content: unknown): Message {
  return {
    id: 99, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 0,
    parts: [
      { type: 'tool_call', id: 'prev', name, args },
      { type: 'tool_result', call_id: 'prev', name, content },
    ],
  } as Message
}

async function metadataOf(h: Harness, relativePath: string) {
  const [row] = await h.db.select({ description: memories.description })
    .from(workspaceFiles).leftJoin(memories, eq(memories.file_id, workspaceFiles.id))
    .where(eq(workspaceFiles.relative_path, relativePath))
  return row
}

describe('memory_save', () => {
  let h: Harness
  beforeEach(async () => { h = await harness() })

  it('creates a memory: the file and its catalog line together', async () => {
    const turn = await startTurn(h)
    const result = await save(turn, { path: '/memory/user/topics/style.md', description: 'prefers terse replies', content: 'Keep it short.' })
    expect(result).toMatchObject({ path: '/memory/user/topics/style.md', operation: 'created', version: 1, metadata: 'created', category: 'topics' })
    expect(await metadataOf(h, 'topics/style.md')).toEqual({ description: 'prefers terse replies' })
  })

  it('describes an existing file without touching it, binary included', async () => {
    const turn = await startTurn(h)
    await run(turn, 'write_file', { path: '/memory/project/areas/notes.md', content: 'raw' })
    const result = await save(turn, { path: '/memory/project/areas/notes.md', description: 'release notes' })
    expect(result).toMatchObject({ metadata: 'created', category: 'areas' })
    expect(result.version).toBeUndefined()
    expect((await h.files.read({ path: '/memory/project/areas/notes.md', conversationId: h.conversationId, projectId: h.projectId, memory: { user: true, project: true } })).ok).toBe(true)

    const again = await save(turn, { path: '/memory/project/areas/notes.md', description: 'where the notes live' })
    expect(again).toMatchObject({ metadata: 'updated' })
    expect(await metadataOf(h, 'areas/notes.md')).toEqual({ description: 'where the notes live' })
  })

  it('saves only into the layout, telling the model what the layout is', async () => {
    const turn = await startTurn(h)
    const refused = await save(turn, { path: '/memory/user/notes.md', content: 'x' })
    expect(refused).toMatchObject({ error: 'INVALID_PATH' })
    expect(String(refused.message)).toContain('topics/<topic>.md')
    expect(await save(turn, { path: '/memory/user/topics/deep/notes.md', content: 'x' })).toMatchObject({ error: 'INVALID_PATH' })
    expect(await save(turn, { path: '/memory/user/profile.md', content: 'x' })).toMatchObject({ category: 'profile' })
  })

  it('refuses to describe a file that does not exist, and anything outside /memory', async () => {
    const turn = await startTurn(h)
    expect(await save(turn, { path: '/memory/user/topics/missing.md' })).toMatchObject({ error: 'FILE_NOT_FOUND' })
    expect(await save(turn, { path: '/project/a.md', content: 'x' })).toMatchObject({ error: 'INVALID_PATH' })
    expect(await save(turn, { path: '/memory/user' , content: 'x' })).toMatchObject({ error: 'INVALID_PATH' })
  })

  it('keeps the description with the file through a rename, hides it on delete and brings it back on restore', async () => {
    const turn = await startTurn(h)
    await save(turn, { path: '/memory/user/topics/a.md', description: 'kept', content: 'body' })
    await run(turn, 'rename_file', { path: '/memory/user/topics/a.md', toPath: '/memory/project/topics/b.md' })
    expect(await metadataOf(h, 'topics/b.md')).toEqual({ description: 'kept' })

    await run(turn, 'delete_file', { path: '/memory/project/topics/b.md' })
    const fresh = async () => {
      await h.db.delete(memorySnapshots)
      return memoryPreamble({ db: h.db, userId: 1, conversationId: h.conversationId, projectId: h.projectId, scopes: { user: true, project: true }, readFile: async () => null })
    }
    expect(await fresh()).not.toContain('b.md')
    const [trashed] = await h.files.listTrash()
    await h.files.undelete(trashed!.id)
    expect(await fresh()).toContain('- /memory/project/topics/b.md — kept')

    await h.files.softDelete(trashed!.id)
    await h.files.purge([trashed!.id])
    expect(await h.db.select().from(memories)).toEqual([])
  })

  it('leaves the description unwritten when another write lands between the content and it', async () => {
    const turn0 = await startTurn(h)
    await save(turn0, { path: '/memory/user/topics/race.md', description: 'original', content: 'v1' })

    // Someone else's write lands after this save's content and before its catalog line.
    const client = h.db.$client
    const racing = new Proxy(client, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key)
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (!sql.includes('INSERT INTO memories')) return statement
          return {
            bind: (...args: unknown[]) => ({
              run: async () => {
                await h.files.write({ path: '/memory/user/topics/race.md', content: 'theirs', conversationId: h.conversationId, projectId: h.projectId, memory: { user: true, project: true } })
                return statement.bind(...args).run()
              },
            }),
          }
        }
      },
    })
    const raced = new Proxy(h.db, { get: (target, key) => key === '$client' ? racing : Reflect.get(target, key) }) as DB
    const turn = await startTurn(h, { db: raced })
    const result = await save(turn, { path: '/memory/user/topics/race.md', description: 'mine', content: 'v2' })
    expect(result).toMatchObject({ error: 'METADATA_CONFLICT' })
    expect(await metadataOf(h, 'topics/race.md')).toEqual({ description: 'original' })
  })

  it('counts a save from an earlier turn as having seen the file, so it can be edited straight away', async () => {
    const first = await startTurn(h)
    const saved = await save(first, { path: '/memory/user/topics/style.md', content: 'Keep it short.' })

    const next = await startTurn(h, { path: [answered('memory_save', { path: '/memory/user/topics/style.md' }, saved)] })
    const edited = await run(next, 'edit_file', { path: '/memory/user/topics/style.md', oldText: 'short', newText: 'brief' })
    expect(edited).toMatchObject({ version: 2 })
  })

  it('does not count a save without content as having seen the file', async () => {
    const first = await startTurn(h)
    await run(first, 'write_file', { path: '/memory/user/topics/style.md', content: 'Keep it short.' })
    const described = await save(first, { path: '/memory/user/topics/style.md' })

    const next = await startTurn(h, { path: [answered('memory_save', { path: '/memory/user/topics/style.md' }, described)] })
    expect(await run(next, 'edit_file', { path: '/memory/user/topics/style.md', oldText: 'short', newText: 'brief' })).toMatchObject({ error: 'NOT_READ' })
  })
})

describe('memory in the prompt', () => {
  let h: Harness
  beforeEach(async () => { h = await harness() })

  it('leads every turn of a conversation with the same catalog, however memory changes meanwhile', async () => {
    const writer = await startTurn(h)
    await save(writer, { path: '/memory/user/topics/a.md', description: 'first', content: 'x' })
    await h.db.delete(memorySnapshots)

    const first = await startTurn(h)
    expect(first.generation.preamble).toContain('/memory/user/topics/a.md — first')
    await save(first, { path: '/memory/user/topics/b.md', description: 'second', content: 'y' })
    const second = await startTurn(h)
    expect(second.generation.preamble).toBe(first.generation.preamble)
  })

  it('leads with each layer\'s profile and preferences in full, and lists the rest by the layout', async () => {
    const writer = await startTurn(h)
    await save(writer, { path: '/memory/user/profile.md', description: 'who', content: 'Backend engineer, Shanghai.\n' })
    await save(writer, { path: '/memory/user/people/mom.md', description: 'family', content: 'x' })
    await save(writer, { path: '/memory/user/preferences.md', description: 'reply style', content: 'Chinese, terse.' })
    await run(writer, 'write_file', { path: '/memory/user/stray.md', content: 'x' })
    await h.db.delete(memorySnapshots)

    const preamble = (await startTurn(h)).generation.preamble!
    expect(preamble).toContain('<profile path="/memory/user/profile.md">\nBackend engineer, Shanghai.\n</profile>')
    expect(preamble).toContain('</profile>\n<preferences path="/memory/user/preferences.md">\nChinese, terse.\n</preferences>\n- /memory/user/people/mom.md — family')
    expect(preamble).not.toContain('- /memory/user/profile.md')
    expect(preamble).not.toContain('- /memory/user/preferences.md')
    // The stray file comes last, with a way back into the layout.
    expect(preamble).toMatch(/- \/memory\/user\/stray\.md — outside the memory layout: rename_file it to .*\n<\/scope>/)
  })

  it('lets concurrent first turns agree on one catalog', async () => {
    const [a, b] = await Promise.all([startTurn(h), startTurn(h)])
    expect(a.generation.preamble).toBe(b.generation.preamble)
    expect(await h.db.select().from(memorySnapshots)).toHaveLength(1)
  })

  it('renders anew once the conversation belongs to a different Project', async () => {
    const before = await startTurn(h)
    expect(before.generation.preamble).toContain('<scope name="project">')
    const moved = await startTurn(h, { projectId: null })
    expect(moved.generation.preamble).not.toContain('<scope name="project">')
  })

  it('hands a fork the catalog its copied messages were sent with', async () => {
    const original = await startTurn(h)
    const [fork] = await h.db.insert(conversations).values({
      user_id: 1, project_id: h.projectId, title: 'fork', head_message_id: null, provider_id: null,
      model_id: null, system_prompt: null, params: null, tools: [], created_at: 0, updated_at: 0,
    }).returning()
    await h.ctx.parallel('conversation/forked', { userId: 1, sourceConversationId: h.conversationId, conversation: fork!, messageIds: new Map() })
    const [copied] = await h.db.select().from(memorySnapshots).where(eq(memorySnapshots.conversation_id, fork!.id))
    expect(copied!.text).toBe(original.generation.preamble)
  })

  it('hides a layer the conversation switched off, and keeps the other one working', async () => {
    const writer = await startTurn(h)
    await save(writer, { path: '/memory/user/topics/a.md', description: 'personal', content: 'x' })
    await h.db.delete(memorySnapshots)
    await h.db.update(conversations).set({ plugin_settings: { memory: { user_memory: false } } }).where(eq(conversations.id, h.conversationId))

    const turn = await startTurn(h)
    expect(turn.generation.preamble).toContain('User memory is off in this conversation')
    expect(turn.generation.preamble).not.toContain('/memory/user/topics/a.md')
    expect(await run(turn, 'read_file', { file: '/memory/user/topics/a.md' })).toMatchObject({ error: 'FILE_NOT_FOUND' })
    expect(await save(turn, { path: '/memory/user/topics/b.md', content: 'y' })).toMatchObject({ error: 'MOUNT_UNAVAILABLE' })
    expect(await save(turn, { path: '/memory/project/topics/c.md', content: 'z' })).toMatchObject({ operation: 'created' })
  })

  it('renders anew when the open layers change, and reuses the catalog while they do not', async () => {
    const first = await startTurn(h)
    await h.db.update(projects).set({ plugin_settings: { memory: { project_memory: false } } }).where(eq(projects.id, h.projectId))
    const closed = await startTurn(h)
    expect(closed.generation.preamble).not.toBe(first.generation.preamble)
    expect(closed.generation.preamble).toContain('Project memory is off in this conversation')
    const again = await startTurn(h)
    expect(again.generation.preamble).toBe(closed.generation.preamble)
  })

  it('says nothing about memory, and opens nothing, in a turn that does not offer it', async () => {
    const writer = await startTurn(h)
    await save(writer, { path: '/memory/user/topics/a.md', content: 'secret-ish' })

    const plain = await startTurn(h, { toolIds: ['read_file', 'write_file', 'edit_file'] })
    expect(plain.generation.preamble).toBeUndefined()
    expect(h.ctx.promptSections.render(null, { toolIds: plain.generation.toolIds })).toBeNull()
    expect(await run(plain, 'read_file', { file: '/memory/user/topics/a.md' })).toMatchObject({ error: 'FILE_NOT_FOUND' })

    expect(h.ctx.promptSections.render(null, { toolIds: MEMORY_TOOLS })).toContain('<plugin id="memory">')
  })
})
