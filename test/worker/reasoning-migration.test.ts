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
    { type: 'reasoning', text: 'visible legacy summary', providerOptions: { openai: { itemId: 'rs_summary', reasoningEncryptedContent: 'encrypted-summary', retained: 'first', opaque: { flag: true } }, anthropic: { signature: 'other-namespace' } } },
    { type: 'reasoning', text: 'later legacy summary', providerOptions: { openai: { itemId: 'rs_summary', reasoningEncryptedContent: 'encrypted-final', opaque: { flag: false, count: 0, value: null } }, anthropic: { extra: 0 } } },
    { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_summary', reasoningEncryptedContent: null, final: false, nullable: null } } },
    { type: 'tool_call', id: 'call_lookup', name: 'lookup', args: { query: 'fixture' }, providerOptions: { openai: { itemId: 'fc_lookup' } } },
    { type: 'tool_result', call_id: 'call_lookup', name: 'lookup', content: { value: 0 }, providerOptions: { openai: { itemId: 'output_lookup', opaque: null } } },
    { type: 'reasoning', text: 'after tool boundary', providerOptions: { openai: { itemId: 'rs_summary', reasoningEncryptedContent: 'encrypted-after-tool' } } },
    { type: 'reasoning', text: 'different item', providerOptions: { openai: { itemId: 'rs_other' } } },
    { type: 'reasoning', text: 'after different item', providerOptions: { openai: { itemId: 'rs_summary' } } },
    { type: 'text', text: 'current answer', providerOptions: { responses: { itemId: 'msg_current' } } },
    { type: 'reasoning', text: 'foreign reasoning', providerOptions: { anthropic: { signature: 'keep-foreign' } } },
  ]
  await legacy.prepare("INSERT INTO messages (session_id, seq, role, parts, status, created_at) VALUES (1, 1, 'assistant', ?, 'done', 0)").bind(JSON.stringify(parts)).run()
  await legacy.prepare("INSERT INTO messages (session_id, seq, role, parts, status, created_at) VALUES (1, 2, 'assistant', ?, 'done', 0)").bind(JSON.stringify([
    { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_encrypted_only', reasoningEncryptedContent: null } } },
    { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_encrypted_only', reasoningEncryptedContent: 'encrypted-only-final' } } },
  ])).run()
  await applyD1Migrations(legacy, env.TEST_MIGRATIONS)
  const [stored, encryptedOnly] = await createDb(legacy).select().from(messages).orderBy(messages.seq)
  const replay = buildModelMessages({ protocol: 'responses', systemPrompt: null, path: [stored!, encryptedOnly!], attachments: new Map(), assets: new Map() })
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
    { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: 'visible legacy summary' }, { type: 'summary_text', text: 'later legacy summary' }], encrypted_content: 'encrypted-final' },
    { type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{"query":"fixture"}' },
    { type: 'function_call_output', call_id: 'call_lookup', output: '{"value":0}' },
    { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: 'after tool boundary' }], encrypted_content: 'encrypted-after-tool' },
    { type: 'reasoning', id: 'rs_other', summary: [{ type: 'summary_text', text: 'different item' }] },
    { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: 'after different item' }] },
    { type: 'message', role: 'assistant', id: 'msg_current', content: [{ type: 'output_text', text: 'current answer' }] },
    { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'foreign reasoning' }] },
    { type: 'reasoning', id: 'rs_encrypted_only', summary: [], encrypted_content: 'encrypted-only-final' },
  ])
  expect(stored!.parts).toEqual([
    { type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'rs_empty', reasoningEncryptedContent: 'encrypted-empty', reasoningSummary: [], reasoningContent: null } } },
    { type: 'text', text: 'before tool', providerOptions: { responses: { itemId: 'msg_before', annotations: [], opaque: { flag: false, count: 0, value: null } } } },
    { type: 'reasoning', text: 'visible legacy summary\nlater legacy summary\n', providerOptions: { responses: { itemId: 'rs_summary', reasoningEncryptedContent: 'encrypted-final', retained: 'first', opaque: { flag: false, count: 0, value: null }, final: false, nullable: null, reasoningSummary: [{ type: 'summary_text', text: 'visible legacy summary' }, { type: 'summary_text', text: 'later legacy summary' }], reasoningContent: null }, anthropic: { signature: 'other-namespace', extra: 0 } } },
    { type: 'tool_call', id: 'call_lookup', name: 'lookup', args: { query: 'fixture' }, providerOptions: { responses: { itemId: 'fc_lookup' } } },
    { type: 'tool_result', call_id: 'call_lookup', name: 'lookup', content: { value: 0 }, providerOptions: { responses: { itemId: 'output_lookup', opaque: null } } },
    { type: 'reasoning', text: 'after tool boundary', providerOptions: { responses: { itemId: 'rs_summary', reasoningEncryptedContent: 'encrypted-after-tool', reasoningSummary: [{ type: 'summary_text', text: 'after tool boundary' }], reasoningContent: null } } },
    { type: 'reasoning', text: 'different item', providerOptions: { responses: { itemId: 'rs_other', reasoningSummary: [{ type: 'summary_text', text: 'different item' }], reasoningContent: null } } },
    { type: 'reasoning', text: 'after different item', providerOptions: { responses: { itemId: 'rs_summary', reasoningSummary: [{ type: 'summary_text', text: 'after different item' }], reasoningContent: null } } },
    parts[10], parts[11],
  ])
  expect(stored!.parts.filter(part => part.type === 'reasoning').map(part => part.text).join('\n'))
    .toBe(parts.filter(part => part.type === 'reasoning').map(part => part.text).join('\n'))
  expect(encryptedOnly!.parts).toEqual([
    { type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'rs_encrypted_only', reasoningEncryptedContent: 'encrypted-only-final', reasoningSummary: [], reasoningContent: null } } },
  ])
})
