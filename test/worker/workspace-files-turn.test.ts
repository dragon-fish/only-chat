import { env } from 'cloudflare:workers'
import { Context } from 'cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from 'ai'
import { createDb, type DB } from '@/server/db/client'
import { conversations, messages, projects, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { ToolRegistry, type ToolContext } from '@/server/plugins/tools'
import { WorkspaceFiles } from '@/server/plugins/workspace-files/service'
import { WorkspaceFilesServerPlugin } from '@/plugins/workspace-files/server'
import type { ReadFileOutput, WriteFileOutput } from '@/plugins/workspace-files/shared'
import { ensureTestUser } from './auth-helper'

/**
 * Exercises the tools directly, because what is under test is per-turn state: a read and a write in
 * the same generation, with someone else's write landing in between. A model-driven run cannot
 * produce that ordering on demand.
 */
interface Fixture {
  db: DB
  tools: Record<string, Tool>
  turn: Map<string, unknown>
  files: WorkspaceFiles
  conversationId: number
}

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

  const ctx = new Context()
  ctx.provide('pluginConfig', { readIfConfigurable: async () => ({}) })
  const registry = new ToolRegistry(ctx)
  // Constructing the Service provides ctx.tools, which is all the plugin needs to register on.
  WorkspaceFilesServerPlugin.apply(ctx)

  // Provenance has a real foreign key, so the runtime needs a message that exists.
  const [assistant] = await db.insert(messages).values({
    conversation_id: conversation!.id, parent_id: null, seq: 0, role: 'assistant', parts: [],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  }).returning()

  const objects = new Map<string, Uint8Array>()
  const assets = {
    put: async (key: string, bytes: Uint8Array | ArrayBuffer) => {
      objects.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    },
    getBytes: async (key: string) => {
      const bytes = objects.get(key)
      return bytes ? { bytes } : null
    },
  }
  const turn = new Map<string, unknown>()
  const runtime: ToolContext = {
    userId: 1,
    conversationId: conversation!.id,
    projectId: project!.id,
    assistantMessageId: assistant!.id,
    config: {},
    conversationConfig: {},
    turn,
    db,
    assets: assets as never,
    signal: new AbortController().signal,
  }
  const built = await registry.resolve(['read_file', 'write_file'], { workspace_files: true }, { ...runtime, pluginSettings: null })
  return {
    db,
    tools: Object.fromEntries(built),
    turn,
    files: new WorkspaceFiles(db, runtime.assets as never, 1),
    conversationId: conversation!.id,
  }
}

const run = async (tool: Tool, input: unknown) =>
  (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 'c1', messages: [] })

describe('workspace files per-turn read tracking', () => {
  let f: Fixture
  beforeEach(async () => { f = await fixture() })

  it('warns only when the write went over a version this turn never read', async () => {
    const scope = { conversationId: f.conversationId, projectId: null }
    await f.files.write({ path: '/conversation/a.md', content: 'v1', ...scope })

    const read = await run(f.tools.read_file!, { path: '/conversation/a.md' }) as ReadFileOutput
    expect(read.version).toBe(1)

    // Replacing exactly what was read is ordinary: no warning, just a note about the displacement.
    const plain = await run(f.tools.write_file!, { path: '/conversation/a.md', content: 'v2' }) as WriteFileOutput
    expect(plain).toMatchObject({ operation: 'replaced', replacedVersion: 1, staleReadVersion: null })
    expect(plain.message).not.toContain('never saw')

    // Someone else writes; this turn's knowledge is now one version behind.
    await f.files.write({ path: '/conversation/a.md', content: 'v3 by someone else', ...scope })

    const stale = await run(f.tools.write_file!, { path: '/conversation/a.md', content: 'v4' }) as WriteFileOutput
    expect(stale).toMatchObject({ operation: 'replaced', replacedVersion: 3, staleReadVersion: 2 })
    expect(stale.message).toContain('never saw')
    expect(stale.message).toContain('restore_file')
  })

  it('treats a version it wrote itself as one it has seen', async () => {
    const scope = { conversationId: f.conversationId, projectId: null }
    await f.files.write({ path: '/conversation/c.md', content: 'v1', ...scope })
    await run(f.tools.read_file!, { path: '/conversation/c.md' })

    // read v1 -> write v2 -> write v3. Nothing landed in between, so the turn has seen every
    // version it is replacing, even the ones it never read back.
    const first = await run(f.tools.write_file!, { path: '/conversation/c.md', content: 'v2' }) as WriteFileOutput
    const second = await run(f.tools.write_file!, { path: '/conversation/c.md', content: 'v3' }) as WriteFileOutput
    expect(first).toMatchObject({ version: 2, replacedVersion: 1, staleReadVersion: null })
    expect(second).toMatchObject({ version: 3, replacedVersion: 2, staleReadVersion: null })
    expect(second.message).not.toContain('never saw')
  })

  it('says nothing about staleness when the file was never read this turn', async () => {
    await f.files.write({ path: '/conversation/b.md', content: 'v1', conversationId: f.conversationId, projectId: null })
    const blind = await run(f.tools.write_file!, { path: '/conversation/b.md', content: 'v2' }) as WriteFileOutput
    // Nothing was read, so there is no expectation to have been violated.
    expect(blind).toMatchObject({ replacedVersion: 1, staleReadVersion: null })
    expect(blind.message).not.toContain('never saw')
  })
})
