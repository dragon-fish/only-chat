import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { attachments, workspaceFileVersions, workspaceFiles } from '@/server/db/schema'
import { createConversation, forkConversation, insertMessage } from '@/server/plugins/hub/conversations'
import { WorkspaceFiles, sweepTrash, type WorkspaceStorage } from '@/server/plugins/workspace-files/service'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

function memoryStorage() {
  const objects = new Map<string, Uint8Array>()
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
  await db.delete(attachments)
  return db
}

async function seedConversationWithFile(db: DB, files: WorkspaceFiles, title: string) {
  const conversation = await createConversation(db, { user_id: 1, title, provider_id: null, model_id: null })
  const root = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: null, seq: 1, role: 'user',
    parts: [{ type: 'text', text: 'hi' }], provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 1,
  })
  await files.write({ path: '/conversation/notes.md', content: 'precious', conversationId: conversation.id, projectId: null, memory: { user: false, project: false } })
  return { conversation, root }
}

describe('a deleted conversation leaves its files behind instead of destroying them', () => {
  it('detaches live files into the orphan list', async () => {
    const db = await freshDb()
    const { storage } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const { conversation } = await seedConversationWithFile(db, files, 'doomed')

    const detached = await files.detachConversationFiles(conversation.id)

    expect(detached.files).toBe(1)
    const orphans = await files.listOrphans()
    expect(orphans.map(file => file.relativePath)).toEqual(['notes.md'])
  })

  it('keeps orphans out of the ordinary trash, which is listed by where a file lived', async () => {
    const db = await freshDb()
    const { storage } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const { conversation } = await seedConversationWithFile(db, files, 'doomed')
    await files.write({ path: '/conversation/other.md', content: 'trashed', conversationId: conversation.id, projectId: null, memory: { user: false, project: false } })
    const [other] = await db.select({ id: workspaceFiles.id }).from(workspaceFiles)
      .where(eq(workspaceFiles.relative_path, 'other.md'))
    await files.softDelete(other!.id)

    await files.detachConversationFiles(conversation.id)

    expect((await files.listTrash()).map(file => file.relativePath)).toEqual(['other.md'])
    expect((await files.listOrphans()).map(file => file.relativePath)).toEqual(['notes.md'])
  })

  it('still reclaims an orphan once its retention runs out', async () => {
    const db = await freshDb()
    const { storage, objects } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const { conversation } = await seedConversationWithFile(db, files, 'doomed')
    await files.detachConversationFiles(conversation.id)

    const swept = await sweepTrash(db, storage, Date.now() + 31 * 24 * 60 * 60 * 1000)

    expect(swept.files).toBe(1)
    expect(swept.bytes).toBeGreaterThan(0)
    expect(objects.size).toBe(0)
  })
})

describe('the hub detaches files before the conversation row goes', () => {
  it('leaves a deleted conversation\'s files in the orphan list', async () => {
    const db = await freshDb()
    const { storage } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const { conversation } = await seedConversationWithFile(db, files, 'doomed')

    const client = await connect(await ensureTestUser())
    client.ws.send(JSON.stringify({ type: 'conversation.delete', request_id: 'del-1', conversation_id: conversation.id }))
    await client.next('conversation.deleted')

    expect((await files.listOrphans()).map(file => file.relativePath)).toEqual(['notes.md'])
  })

  /**
   * The rollback deletes a conversation nobody ever saw. Its copied rows must go with it — a fork
   * that failed has no business leaving files in the user's orphan list.
   */
  it('does not orphan the files a failed fork had already copied', async () => {
    const db = await freshDb()
    const { storage } = memoryStorage()
    const files = new WorkspaceFiles(db, storage, 1)
    const { conversation, root } = await seedConversationWithFile(db, files, 'source')

    await expect(forkConversation(db, conversation.id, 1, root.id, async (payload) => {
      await files.copyConversationFiles(payload.sourceConversationId, payload.conversation.id)
      throw new Error('a later subscriber failed')
    })).rejects.toThrow('a later subscriber failed')

    expect(await files.listOrphans()).toEqual([])
    const rows = await db.select({ id: workspaceFiles.id }).from(workspaceFiles)
      .where(eq(workspaceFiles.conversation_id, conversation.id))
    expect(rows).toHaveLength(1)
  })
})
