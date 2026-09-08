import { expect, it } from 'vitest'
import { sessionExporters } from '@/client/lib/session-export'
import type { Message, Session } from '@/shared/models'

const session: Session = { id: 1, user_id: 1, project_id: null, title: 'Export', head_message_id: 2, provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], created_at: 1, updated_at: 1, archived_at: null }
const messages: Message[] = [
  { id: 1, session_id: 1, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'Hello' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1 },
  { id: 2, session_id: 1, parent_id: 1, seq: 2, role: 'assistant', parts: [{ type: 'reasoning', text: 'Think' }, { type: 'text', text: 'World' }], provider_id: 1, model_id: 'm', usage: { prompt: 2, completion: 1 }, status: 'done', error: null, created_at: 2 },
]

it('exports the supplied current path as readable Markdown and lossless JSON', () => {
  const context = { session, messages, attachmentUrl: (id: number) => `https://only.chat/a/${id}` }
  const markdown = sessionExporters.markdown.serialize(context)
  expect(markdown).toContain('Hello')
  expect(markdown).toContain('<details>')
  const json = JSON.parse(sessionExporters.json.serialize(context))
  expect(json).toMatchObject({ version: 1, session: { id: 1 }, messages: [{ id: 1 }, { id: 2, usage: { prompt: 2 } }] })
})
