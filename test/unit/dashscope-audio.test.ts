import { afterEach, expect, it, vi } from 'vitest'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { ModelRow, ProviderRow } from '@/server/db/schema'
import { chatCompletionsAdapter } from '@/server/plugins/llm/protocols/chat-completions'

const provider: ProviderRow = { id: 1, user_id: 1, name: 'Audio', api_key: null, enabled: true, default_interface_id: 1, credential_version: 1, models_dev_provider_id: 'alibaba-cn', models_dev_provider_source: 'endpoint', default_image_model_id: null, model_revision: 1, created_at: 0 }
const model: ModelRow = { id: 1, provider_id: 1, model_id: 'qwen3.8-omni-flash', interface_id: null, metadata_override: {}, metadata_resolved: { modalities: { input: ['text', 'audio'], output: ['text'] } }, catalog_matches: { operator: null, lab: null, global: null }, provider_metadata: {}, image_extra_body: {}, lab_id: null, supports_image_input: false, supports_reasoning: false, supports_tools: false, supports_image_output: false, context_limit: null, output_limit: null, enabled: true, manual_pinned: true, upstream_available: true, sort: 0 }
afterEach(() => vi.unstubAllGlobals())

it.each([
  ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'data:audio/mp3;base64,AQID'],
  ['https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'data:audio/mp3;base64,AQID'],
  ['https://other.example/v1', 'AQID'],
])('encodes the audio data field for %s', async (base_url, expected) => {
  let body: { messages: Array<{ content: Array<{ input_audio: { data: string; format: string } }> }> } | undefined
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body))
    return Response.json({ id: 'r', object: 'chat.completion', created: 1, model: model.model_id, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  })
  const llm = chatCompletionsAdapter.createModel(provider, { id: 1, provider_id: 1, protocol: 'chat-completions', base_url, native_files: false, created_at: 0 }, model, 'test-key') as LanguageModelV4
  await llm.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'audio/mpeg', data: { type: 'data', data: new Uint8Array([1, 2, 3]) } }] }] })
  expect(body!.messages[0]!.content[0]!.input_audio).toEqual({ data: expected, format: 'mp3' })
})
