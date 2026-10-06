import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { memoryState } from '@/server/db/schema'
import { createConversation, insertMessage, listMessages, toMessage, updateConversation } from '@/server/plugins/hub/conversations'
import { WorkspaceFiles } from '@/server/plugins/workspace-files/service'
import type { UserHub } from '@/server/index'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

/** The hub's own compose and commit reach the memory plugin, which records what the checkpoint showed. */
it('records the catalog a checkpoint carries as what its conversation knows', async () => {
  const db = createDb(env.DB)
  await connect(await ensureTestUser(db))
  const conversation = await createConversation(db, { user_id: 1, title: 't', provider_id: null, model_id: null })
  const user = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hi' }],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  })
  const assistant = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: user.id, seq: 2, role: 'assistant', parts: [{ type: 'text', text: 'hello' }],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  })
  await updateConversation(db, conversation.id, 1, { head_message_id: assistant.id })
  const scope = { conversationId: conversation.id, projectId: null, memory: { user: true, project: false } }
  const path = (await listMessages(db, conversation.id, 1)).map(row => toMessage(row))

  await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
    const files = new WorkspaceFiles(instance.app.db.orm, instance.app.assets, 1)
    await files.write({ path: '/memory/user/topics/shown.md', content: 'x', ...scope })
    const { hub } = instance.app
    const composed = await hub.checkpoints.compose({ conversationId: conversation.id, projectId: null, toolIds: ['memory_save'], path })
    expect(composed.contributors).toEqual(['memory'])
    expect(composed.blocks[0]!.text).toContain('- /memory/user/topics/shown.md')
    expect(await db.select().from(memoryState).where(eq(memoryState.conversation_id, conversation.id))).toEqual([])

    await files.write({ path: '/memory/user/topics/later.md', content: 'y', ...scope })
    await hub.checkpoints.commit({
      conversationId: conversation.id, expectedHead: assistant.id, usage: null,
      part: { type: 'checkpoint', plugin: 'context_compaction', content: 'SUMMARY', attachments: [], contributors: composed.contributors, data: null },
    })
  })

  const [state] = await db.select().from(memoryState).where(eq(memoryState.conversation_id, conversation.id))
  expect(Object.values(state!.known).map(file => file.path)).toEqual(['/memory/user/topics/shown.md'])
  expect(state!.scopes).toBe('user')
})
