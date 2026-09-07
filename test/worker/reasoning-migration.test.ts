import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { createOpenResponses } from '@ai-sdk/open-responses'
import { streamText } from 'ai'
import { expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { messages } from '@/server/db/schema'
import { buildModelMessages } from '@/server/plugins/llm/messages'
import { deepseekResponsesStream } from '../fixtures/deepseek-responses-stream'

it('migrates legacy OpenAI metadata into lossless summary and encrypted Responses replay', async () => {
  const legacy = env.TEST_LEGACY_DB
  await applyD1Migrations(legacy, env.TEST_MIGRATIONS.slice(0, 2))
  await legacy.prepare("INSERT INTO users (id, name, settings, created_at) VALUES (1, 'owner', '{}', 0)").run()
  await legacy.prepare("INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (1, 1, 'legacy', 0, 0)").run()
  const parts = [
    { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_empty', reasoningEncryptedContent: 'encrypted-empty' } } },
    { type: 'text', text: 'before tool', providerOptions: { openai: { itemId: 'msg_before', annotations: [], opaque: { flag: false, count: 0, value: null } } } },
    { type: 'reasoning', text: 'visible legacy summary', providerOptions: { openai: { itemId: 'rs_summary', reasoningEncryptedContent: 'encrypted-summary' }, anthropic: { signature: 'other-namespace' } } },
    { type: 'tool_call', id: 'call_lookup', name: 'lookup', args: { query: 'fixture' }, providerOptions: { openai: { itemId: 'fc_lookup' } } },
    { type: 'tool_result', call_id: 'call_lookup', name: 'lookup', content: { value: 0 }, providerOptions: { openai: { itemId: 'output_lookup', opaque: null } } },
    { type: 'text', text: 'current answer', providerOptions: { responses: { itemId: 'msg_current' } } },
    { type: 'reasoning', text: 'foreign reasoning', providerOptions: { anthropic: { signature: 'keep-foreign' } } },
  ]
  await legacy.prepare("INSERT INTO messages (session_id, seq, role, parts, status, created_at) VALUES (1, 1, 'assistant', ?, 'done', 0)").bind(JSON.stringify(parts)).run()
  await applyD1Migrations(legacy, env.TEST_MIGRATIONS)
  const [stored] = await createDb(legacy).select().from(messages)
  const replay = buildModelMessages({ protocol: 'responses', systemPrompt: null, path: [stored!], attachments: new Map() })
  let body: { input: unknown[] } | undefined
  const model = createOpenResponses({
    name: 'responses', url: 'https://fixture.test/responses',
    fetch: async (input, init) => {
      body = await new Request(input, init).json()
      return deepseekResponsesStream()
    },
  })('fixture-model')
  for await (const chunk of streamText({ model, messages: replay }).stream) if (chunk.type === 'error') throw chunk.error
  expect(body!.input).toEqual([
    { type: 'reasoning', id: 'rs_empty', summary: [], encrypted_content: 'encrypted-empty' },
    { type: 'message', role: 'assistant', id: 'msg_before', content: [{ type: 'output_text', text: 'before tool', annotations: [] }] },
    { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: 'visible legacy summary' }], encrypted_content: 'encrypted-summary' },
    { type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{"query":"fixture"}' },
    { type: 'function_call_output', call_id: 'call_lookup', output: '{"value":0}' },
    { type: 'message', role: 'assistant', id: 'msg_current', content: [{ type: 'output_text', text: 'current answer' }] },
    { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'foreign reasoning' }] },
  ])
  expect(stored!.parts).toEqual([
    { type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'rs_empty', reasoningEncryptedContent: 'encrypted-empty', reasoningSummary: [], reasoningContent: null } } },
    { type: 'text', text: 'before tool', providerOptions: { responses: { itemId: 'msg_before', annotations: [], opaque: { flag: false, count: 0, value: null } } } },
    { type: 'reasoning', text: 'visible legacy summary', providerOptions: { responses: { itemId: 'rs_summary', reasoningEncryptedContent: 'encrypted-summary', reasoningSummary: [{ type: 'summary_text', text: 'visible legacy summary' }], reasoningContent: null }, anthropic: { signature: 'other-namespace' } } },
    { type: 'tool_call', id: 'call_lookup', name: 'lookup', args: { query: 'fixture' }, providerOptions: { responses: { itemId: 'fc_lookup' } } },
    { type: 'tool_result', call_id: 'call_lookup', name: 'lookup', content: { value: 0 }, providerOptions: { responses: { itemId: 'output_lookup', opaque: null } } },
    parts[5], parts[6],
  ])
})
