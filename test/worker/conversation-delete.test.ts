import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureTestUser as seedTestUser } from './auth-helper'
import { createConversation, deleteConversation, getConversation, insertMessage, listMessages } from '@/server/plugins/hub/conversations'

describe('deleting a conversation', () => {
  // A fork copies its path as one chain, so a long conversation forked is a deep one.
  it('deletes a conversation whose messages form a long chain', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const conversation = await createConversation(db, { user_id: 1, title: 'deep', provider_id: null, model_id: null })
    let parentId: number | null = null
    for (let seq = 1; seq <= 150; seq++) {
      const message = await insertMessage(db, 1, {
        conversation_id: conversation.id, parent_id: parentId, seq, role: seq % 2 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `m${seq}` }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: seq,
      })
      parentId = message.id
    }

    await deleteConversation(db, conversation.id, 1)

    expect(await getConversation(db, conversation.id, 1)).toBeUndefined()
    expect(await listMessages(db, conversation.id, 1)).toEqual([])
  })
})
