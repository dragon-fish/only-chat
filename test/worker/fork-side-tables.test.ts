import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import {
  attachments, conversations, messages, projects, workspaceFileVersions, workspaceFiles,
} from '@/server/db/schema'
import {
  createConversation, forkConversation, insertMessage, updateConversation,
  type ConversationForked,
} from '@/server/plugins/hub/conversations'
import { WorkspaceFiles, type WorkspaceStorage } from '@/server/plugins/workspace-files/service'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

/** In-memory object storage: these tests are about which rows survive a fork, not about R2. */
function memoryStorage(objects = new Map<string, Uint8Array>()) {
  const storage: WorkspaceStorage = {
    put: async (key, bytes) => { objects.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) },
    delete: async (key) => { objects.delete(key) },
    getBytes: async (key) => {
      const bytes = objects.get(key)
      return bytes ? { bytes } : null
    },
  }
  return { storage, objects }
}

async function freshDb(): Promise<DB> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  await db.delete(workspaceFileVersions)
  await db.delete(workspaceFiles)
  // Last: version rows reference attachments with ON DELETE RESTRICT.
  await db.delete(attachments)
  return db
}

async function conversationIds(db: DB): Promise<number[]> {
  const rows = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.user_id, 1))
  return rows.map(row => row.id).sort((a, b) => a - b)
}

/** A two-message conversation, because a fork has to remap parents as well as ids. */
async function seedConversation(db: DB, title: string) {
  const conversation = await createConversation(db, { user_id: 1, title, provider_id: null, model_id: null })
  const user = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: null, seq: 1, role: 'user',
    parts: [{ type: 'text', text: 'draw me something' }], provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 1,
  })
  const assistant = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: user.id, seq: 2, role: 'assistant',
    parts: [{ type: 'text', text: 'here you go' }], provider_id: null, model_id: 'm',
    usage: null, status: 'done', error: null, created_at: 2,
  })
  return { conversation, user, assistant }
}

describe('forkConversation notifies side-table owners', () => {
  it('reports the new conversation and how each source message was renumbered', async () => {
    const db = await freshDb()
    const source = await seedConversation(db, 'source')

    let seen: ConversationForked | null = null
    const forked = await forkConversation(db, source.conversation.id, 1, source.assistant.id, async (payload) => {
      seen = payload
    })

    expect(seen).not.toBeNull()
    const payload = seen as unknown as ConversationForked
    expect(payload.userId).toBe(1)
    expect(payload.sourceConversationId).toBe(source.conversation.id)
    expect(payload.conversation.id).toBe(forked.id)
    // Both messages on the path are remapped, and to rows that actually belong to the fork.
    expect([...payload.messageIds.keys()].sort()).toEqual([source.user.id, source.assistant.id].sort())
    for (const newId of payload.messageIds.values()) {
      const [row] = await db.select({ conversation_id: messages.conversation_id }).from(messages).where(eq(messages.id, newId))
      expect(row?.conversation_id).toBe(forked.id)
    }
  })

  it('rolls the fork back when a listener fails, leaving no half-copied conversation', async () => {
    const db = await freshDb()
    const source = await seedConversation(db, 'source')
    const idsBefore = await conversationIds(db)

    await expect(forkConversation(db, source.conversation.id, 1, source.assistant.id, async () => {
      throw new Error('subscriber exploded')
    })).rejects.toThrow('subscriber exploded')

    expect(await conversationIds(db)).toEqual(idsBefore)
  })
})

describe('workspace files follow a fork', () => {
  it('gives the fork its own readable copy of the conversation mount', async () => {
    const db = await freshDb()
    const { storage } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const source = await seedConversation(db, 'source')
    await files.write({ path: '/conversation/notes.md', content: 'kept', conversationId: source.conversation.id, projectId: null, memory: { user: false, project: false } })

    const forked = await forkConversation(db, source.conversation.id, 1, source.assistant.id, async (payload) => {
      await files.copyConversationFiles(payload.sourceConversationId, payload.conversation.id)
    })

    const read = await files.read({ path: '/conversation/notes.md', conversationId: forked.id, projectId: null, memory: { user: false, project: false } })
    expect(read.ok && read.value.content).toContain('kept')
  })

  it('leaves the project mount alone, which the fork already reaches through its project', async () => {
    const db = await freshDb()
    const { storage } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const [project] = await db.insert(projects).values({
      user_id: 1, name: 'p', icon_attachment_id: null, system_prompt: null,
      provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0,
    }).returning()
    const conversation = await createConversation(db, { user_id: 1, title: 'source', provider_id: null, model_id: null, project_id: project!.id })
    const root = await insertMessage(db, 1, {
      conversation_id: conversation.id, parent_id: null, seq: 1, role: 'user',
      parts: [{ type: 'text', text: 'hi' }], provider_id: null, model_id: null,
      usage: null, status: 'done', error: null, created_at: 1,
    })
    await files.write({ path: '/project/shared.md', content: 'shared', conversationId: conversation.id, projectId: project!.id, memory: { user: false, project: false } })

    const forked = await forkConversation(db, conversation.id, 1, root.id, async (payload) => {
      await files.copyConversationFiles(payload.sourceConversationId, payload.conversation.id)
    })

    const projectRows = await db.select({ id: workspaceFiles.id }).from(workspaceFiles)
      .where(eq(workspaceFiles.project_id, project!.id))
    expect(projectRows).toHaveLength(1)
    const read = await files.read({ path: '/project/shared.md', conversationId: forked.id, projectId: project!.id, memory: { user: false, project: false } })
    expect(read.ok && read.value.content).toContain('shared')
  })

  it('keeps the fork readable after the source file is emptied from the trash', async () => {
    const db = await freshDb()
    const { storage, objects } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const source = await seedConversation(db, 'source')
    await files.write({ path: '/conversation/notes.md', content: 'kept', conversationId: source.conversation.id, projectId: null, memory: { user: false, project: false } })

    const forked = await forkConversation(db, source.conversation.id, 1, source.assistant.id, async (payload) => {
      await files.copyConversationFiles(payload.sourceConversationId, payload.conversation.id)
    })

    const [original] = await db.select({ id: workspaceFiles.id }).from(workspaceFiles)
      .where(eq(workspaceFiles.conversation_id, source.conversation.id))
    await files.softDelete(original!.id)
    const purged = await files.purge([original!.id])

    // The fork's own version row still points at the attachment, so the bytes may not be reclaimed.
    expect(purged.bytes).toBe(0)
    expect(objects.size).toBe(1)
    const read = await files.read({ path: '/conversation/notes.md', conversationId: forked.id, projectId: null, memory: { user: false, project: false } })
    expect(read.ok && read.value.content).toContain('kept')
  })
})

/**
 * The unit tests above call the subscribers directly. This one proves the wiring: that the plugins
 * loaded on the hub side actually hear what the Hub emits. A listener registered on the wrong
 * context fails silently, which is the one way this feature can regress without a red test.
 */
describe('the hub carries files over a real fork', () => {
  it('copies the conversation mount when a fork arrives over the socket', async () => {
    const db = await freshDb()
    const { storage } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const source = await seedConversation(db, 'source')
    await updateConversation(db, source.conversation.id, 1, { head_message_id: source.assistant.id })
    await files.write({ path: '/conversation/notes.md', content: 'kept', conversationId: source.conversation.id, projectId: null, memory: { user: false, project: false } })

    const client = await connect(await ensureTestUser())
    client.ws.send(JSON.stringify({
      type: 'conversation.fork', request_id: 'fork-e2e',
      conversation_id: source.conversation.id, message_id: source.assistant.id,
    }))
    const done = await client.next('conversation.forked') as { conversation_id: number }

    const copied = await db.select({ path: workspaceFiles.relative_path }).from(workspaceFiles)
      .where(eq(workspaceFiles.conversation_id, done.conversation_id))
    expect(copied.map(row => row.path)).toEqual(['notes.md'])
  })
})
