import { expect, it } from 'vitest'
import { conversationExporters } from '@/client/lib/conversation-export'
import type { Message, Conversation } from '@/shared/models'

const conversation: Conversation = { id: 1, user_id: 1, project_id: null, title: 'Export', head_message_id: 2, provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], created_at: 1, updated_at: 1, archived_at: null }
const messages: Message[] = [
  { id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'Hello' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1 },
  { id: 2, conversation_id: 1, parent_id: 1, seq: 2, role: 'assistant', parts: [{ type: 'reasoning', text: 'Think' }, { type: 'text', text: 'World' }], provider_id: 1, model_id: 'm', usage: { prompt: 2, completion: 1 }, status: 'done', error: null, created_at: 2 },
]

it('exports the supplied current path as readable Markdown and lossless JSON', () => {
  const context = { conversation, messages, attachmentUrl: (id: number) => `https://only.chat/a/${id}` }
  const markdown = conversationExporters.markdown.serialize(context)
  expect(markdown).toContain('Hello')
  expect(markdown).toContain('<details>')
  const json = JSON.parse(conversationExporters.json.serialize(context))
  expect(json).toMatchObject({ version: 1, conversation: { id: 1 }, messages: [{ id: 1 }, { id: 2, usage: { prompt: 2 } }] })
})
