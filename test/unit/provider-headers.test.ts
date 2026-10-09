import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { ModelRow, ProviderInterfaceRow, ProviderRow } from '@/server/db/schema'
import { withHeaders } from '@/server/plugins/llm/credentials'
import { anthropicAdapter } from '@/server/plugins/llm/protocols/anthropic'
import { chatCompletionsAdapter } from '@/server/plugins/llm/protocols/chat-completions'
import { responsesAdapter } from '@/server/plugins/llm/protocols/responses'
import { vertexCompatibleAdapter } from '@/server/plugins/llm/protocols/vertex-compatible'
import { providerHeadersProblem } from '@/shared/api'

const provider: ProviderRow = { id: 1, user_id: 1, name: 'p', api_key: null, headers: [], enabled: true, default_interface_id: 1, credential_version: 1, models_dev_provider_id: null, models_dev_provider_source: null, default_image_model_id: null, model_revision: 1, created_at: 0 }
const model: ModelRow = { id: 1, provider_id: 1, model_id: 'publisher/model', interface_id: null, metadata_override: {}, metadata_resolved: {}, catalog_matches: { operator: null, lab: null, global: null }, provider_metadata: {}, image_extra_body: {}, lab_id: null, supports_image_input: false, supports_reasoning: false, supports_tools: false, supports_image_output: false, context_limit: null, output_limit: null, enabled: true, manual_pinned: true, upstream_available: true, sort: 0 }
const credentials = { apiKey: 'test-key', headers: { 'anthropic-organization-id': 'org-1' } }

afterEach(() => vi.unstubAllGlobals())

function capture(): () => Request {
  let seen: Request | undefined
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = new Request(input, init)
    throw new Error('captured')
  })
  return () => seen!
}

describe('provider custom headers', () => {
  it.each([
    ['anthropic', anthropicAdapter, 'x-api-key', 'test-key'],
    ['chat-completions', chatCompletionsAdapter, 'authorization', 'Bearer test-key'],
    ['responses', responsesAdapter, 'authorization', 'Bearer test-key'],
    ['vertex-compatible', vertexCompatibleAdapter, 'authorization', 'Bearer test-key'],
  ] as const)('reach the %s upstream beside its own authentication', async (protocol, adapter, authHeader, authValue) => {
    const request = capture()
    const selected: ProviderInterfaceRow = { id: 1, provider_id: 1, protocol, base_url: 'https://api.example/v1', native_files: false, created_at: 0 }
    const llm = adapter.createModel(provider, selected, model, credentials) as LanguageModelV4
    await expect(llm.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })).rejects.toThrow()
    expect(request().headers.get('anthropic-organization-id')).toBe('org-1')
    expect(request().headers.get(authHeader)).toBe(authValue)
  })

  it('are never sent to another origin', async () => {
    const request = capture()
    const send = withHeaders(credentials.headers, 'https://api.example/v1')
    await expect(send('https://cdn.example/image.png')).rejects.toThrow()
    expect(request().headers.get('anthropic-organization-id')).toBeNull()
    await expect(send('https://api.example/v1/models', { headers: { 'x-api-key': 'k' } })).rejects.toThrow()
    expect(request().headers.get('anthropic-organization-id')).toBe('org-1')
    expect(request().headers.get('x-api-key')).toBe('k')
  })

  it('refuse names the credential or the request already sets', () => {
    expect(providerHeadersProblem([{ name: 'Authorization' }])).toMatch(/不能在这里填写/)
    expect(providerHeadersProblem([{ name: 'a' }, { name: 'A' }])).toMatch(/重复/)
    expect(providerHeadersProblem([{ name: 'anthropic-organization-id' }])).toBeNull()
  })
})
