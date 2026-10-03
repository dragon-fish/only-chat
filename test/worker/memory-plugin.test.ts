import { env } from 'cloudflare:workers'
import { Context } from 'cordis'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from 'ai'
import { createDb, type DB } from '@/server/db/client'
import { attachments, conversations, memories, memoryState, messages, projects, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { ToolRegistry, type ToolContext } from '@/server/plugins/tools'
import { PromptSections } from '@/server/plugins/prompt-sections'
import { WorkspaceFiles } from '@/server/plugins/workspace-files/service'
import { WorkspaceFilesServerPlugin } from '@/plugins/workspace-files/server'
import { FileReaderServerPlugin } from '@/plugins/file-reader/server'
import { MemoryServerPlugin } from '@/plugins/memory/server'
import { loadCatalog, renderCatalog } from '@/plugins/memory/server/catalog'
import type { GenerationTurn } from '@/server/plugins/hub/generation-turn'
import { notesByMessage } from '@/server/plugins/hub/generation'
import { appendMessageNotes, forkConversation, getMessage, insertMessage } from '@/server/plugins/hub/conversations'
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
  await db.delete(memoryState)
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
      const catalog = await loadCatalog(h.db, 1, h.projectId, { user: true, project: true }, async () => null)
      return renderCatalog(catalog.user, catalog.project)
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

  /**
   * A conversation as the hub runs it: messages chained in the database, each turn prepared, its
   * new notes stored on their messages, and the path read back the way the next turn would see it.
   */
  function conversation() {
    let path: Message[] = []
    let seq = 100
    const add = async (role: 'user' | 'assistant', text: string) => {
      const row = await insertMessage(h.db, 1, {
        conversation_id: h.conversationId, parent_id: path.at(-1)?.id ?? null, seq: seq++, role,
        parts: [{ type: 'text', text }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
      })
      path = [...path, row as Message]
    }
    const reread = async () => { path = await Promise.all(path.map(async message => (await getMessage(h.db, message.id, 1)) as Message)) }
    return {
      get path() { return path },
      /** The person says something and a turn answers it. */
      async say(text: string, options: { projectId?: number | null, toolIds?: string[] } = {}) {
        await add('user', text)
        return this.answer(options)
      },
      /** A turn answering the path as it stands — a regenerated reply when it already ends at an answered message. */
      async answer(options: { projectId?: number | null, toolIds?: string[], upTo?: number } = {}) {
        const turnPath = options.upTo === undefined ? path : path.slice(0, options.upTo)
        const turn = await startTurn(h, { ...options, path: turnPath })
        for (const [id, notes] of notesByMessage(turn.generation.notes)) await appendMessageNotes(h.db, id, 1, notes)
        await reread()
        return turn
      },
      async reply(text: string) { await add('assistant', text) },
      /** The memory notes on a message of the path. */
      notes(index: number) { return (path.at(index)?.notes ?? []).filter(note => note.plugin === 'memory') },
    }
  }

  /** Another conversation of the same user, changing memory meanwhile. */
  async function otherScope() {
    const [other] = await h.db.insert(conversations).values({
      user_id: 1, project_id: h.projectId, title: 'other', head_message_id: null, provider_id: null,
      model_id: null, system_prompt: null, params: null, tools: [], created_at: 0, updated_at: 0,
    }).returning()
    return { conversationId: other!.id, projectId: h.projectId, memory: { user: true, project: true } }
  }
  const elsewhere = async (path: string, content: string) => h.files.write({ path, content, ...await otherScope() })

  it('leads the first memory turn with the catalog, stored on that message, and adds nothing while memory stays still', async () => {
    await elsewhere('/memory/user/topics/a.md', 'a')
    const c = conversation()
    await c.say('hi')
    expect(c.notes(0)).toHaveLength(1)
    expect(c.notes(0)[0]).toMatchObject({ at: 'start' })
    expect(c.notes(0)[0]!.text).toContain('<memory-catalog>')
    expect(c.notes(0)[0]!.text).toContain('- /memory/user/topics/a.md')

    await c.reply('hello')
    await c.say('more')
    expect(c.notes(-1)).toEqual([])
    // Regenerating the reply to the first message adds nothing to it.
    await c.answer({ upTo: 1 })
    expect(c.notes(0)).toHaveLength(1)
  })

  it('leads with each layer\'s profile and preferences in full, and lists the rest by the layout', async () => {
    const scope = await otherScope()
    await h.files.write({ path: '/memory/user/profile.md', content: 'Backend engineer, Shanghai.\n', ...scope })
    await h.files.write({ path: '/memory/user/preferences.md', content: 'Chinese, terse.', ...scope })
    await h.files.write({ path: '/memory/user/people/mom.md', content: 'x', ...scope })
    await h.files.write({ path: '/memory/user/stray.md', content: 'x', ...scope })
    const c = conversation()
    await c.say('hi')
    const catalog = c.notes(0)[0]!.text
    expect(catalog).toContain('<profile path="/memory/user/profile.md">\nBackend engineer, Shanghai.\n</profile>\n<preferences path="/memory/user/preferences.md">\nChinese, terse.\n</preferences>\n- /memory/user/people/mom.md')
    expect(catalog).not.toContain('- /memory/user/profile.md')
    expect(catalog).toMatch(/- \/memory\/user\/stray\.md — outside the memory layout: rename_file it to .*\n<\/scope>/)
  })

  it('reminds the next user message of what changed elsewhere, carrying a changed profile whole', async () => {
    const c = conversation()
    await c.say('hi')
    await elsewhere('/memory/user/topics/food.md', 'spicy')
    await elsewhere('/memory/user/profile.md', 'Engineer.')
    await c.reply('hello')
    await c.say('lunch?')
    expect(c.notes(-1)).toHaveLength(1)
    const { text, at } = c.notes(-1)[0]!
    expect(at).toBeUndefined()
    expect(text).toContain('- new /memory/user/topics/food.md')
    expect(text).toContain('<profile path="/memory/user/profile.md">\nEngineer.\n</profile>')

    await c.reply('sure')
    await c.say('thanks')
    expect(c.notes(-1)).toEqual([])
  })

  it('does not remind a conversation of what its own turn changed', async () => {
    const c = conversation()
    const first = await c.say('remember I like tea')
    await save(first, { path: '/memory/user/topics/drinks.md', description: 'tea', content: '- tea' })
    await run(first, 'rename_file', { path: '/memory/user/topics/drinks.md', toPath: '/memory/user/topics/beverages.md' })
    await h.ctx.parallel('generation/settled', first.generation)
    await c.reply('noted')
    await c.say('ok')
    expect(c.notes(-1)).toEqual([])
  })

  it('reminds of a move and a delete made elsewhere', async () => {
    await elsewhere('/memory/user/topics/a.md', 'a')
    await elsewhere('/memory/user/topics/b.md', 'b')
    const c = conversation()
    await c.say('hi')
    const scope = await otherScope()
    await h.files.rename({ path: '/memory/user/topics/a.md', toPath: '/memory/project/topics/a.md', ...scope })
    await h.files.deleteByPath({ path: '/memory/user/topics/b.md', ...scope })
    await c.reply('hello')
    await c.say('again')
    const { text } = c.notes(-1)[0]!
    expect(text).toContain('- moved /memory/user/topics/a.md → /memory/project/topics/a.md')
    expect(text).toContain('- removed /memory/user/topics/b.md')
  })

  it('says once that a layer was switched off, and stops letting the model reach it', async () => {
    await elsewhere('/memory/user/topics/a.md', 'personal')
    const c = conversation()
    await c.say('hi')
    await h.db.update(conversations).set({ plugin_settings: { memory: { user_memory: false } } }).where(eq(conversations.id, h.conversationId))
    await c.reply('hello')
    const turn = await c.say('more')
    expect(c.notes(-1)[0]!.text).toContain('User memory is now off in this conversation')
    expect(await run(turn, 'read_file', { file: '/memory/user/topics/a.md' })).toMatchObject({ error: 'FILE_NOT_FOUND' })
    expect(await save(turn, { path: '/memory/user/topics/b.md', content: 'y' })).toMatchObject({ error: 'MOUNT_UNAVAILABLE' })
    expect(await save(turn, { path: '/memory/project/topics/c.md', content: 'z' })).toMatchObject({ operation: 'created' })
    await h.ctx.parallel('generation/settled', turn.generation)

    await c.reply('ok')
    await c.say('still here')
    expect(c.notes(-1)).toEqual([])
  })

  it('introduces the project memory of a Project the conversation moved into, and says when it has none', async () => {
    const c = conversation()
    await c.say('hi')
    const [other] = await h.db.insert(projects).values({
      user_id: 1, name: 'q', icon_attachment_id: null, system_prompt: null,
      provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0,
    }).returning()
    await h.files.write({ path: '/memory/project/areas/launch.md', content: 'x', conversationId: h.conversationId, projectId: other!.id, memory: { user: true, project: true } })
    await c.reply('hello')
    await c.say('moved', { projectId: other!.id })
    expect(c.notes(-1)[0]!.text).toContain('This conversation is now in a different Project, with project memory of its own:')
    expect(c.notes(-1)[0]!.text).toContain('- /memory/project/areas/launch.md')

    await c.reply('ok')
    await c.say('out of projects', { projectId: null })
    expect(c.notes(-1)[0]!.text).toContain('Project memory is now off in this conversation')
  })

  it('gives a fork the catalog and reminders it copies, and what they told it', async () => {
    const c = conversation()
    await c.say('hi')
    await elsewhere('/memory/user/topics/food.md', 'spicy')
    await c.reply('hello')
    await c.say('lunch?')
    const fork = await forkConversation(h.db, h.conversationId, 1, c.path.at(-1)!.id, payload => h.ctx.parallel('conversation/forked', payload))
    const copied = await h.db.select().from(messages).where(eq(messages.conversation_id, fork.id))
    expect(copied.find(message => message.seq === 1)?.notes).toEqual(c.path[0]!.notes)
    expect(copied.find(message => message.seq === 3)?.notes).toEqual(c.path[2]!.notes)
    expect(await h.db.select().from(memoryState).where(eq(memoryState.conversation_id, fork.id))).toHaveLength(1)
  })

  it('says nothing about memory, and opens nothing, in a turn that does not offer it', async () => {
    await elsewhere('/memory/user/topics/a.md', 'secret-ish')
    const c = conversation()
    const plain = await c.say('hi', { toolIds: ['read_file', 'write_file', 'edit_file'] })
    expect(c.notes(0)).toEqual([])
    expect(h.ctx.promptSections.render(null, { toolIds: plain.generation.toolIds })).toBeNull()
    expect(await run(plain, 'read_file', { file: '/memory/user/topics/a.md' })).toMatchObject({ error: 'FILE_NOT_FOUND' })
    expect(h.ctx.promptSections.render(null, { toolIds: MEMORY_TOOLS })).toContain('<plugin id="memory">')
  })
})
