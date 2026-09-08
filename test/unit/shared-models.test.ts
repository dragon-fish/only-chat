import { describe, expect, it } from 'vitest'
import {
  InterfaceProtocolSchema, MessageSchema, ModelPageSchema, ModelQuerySchema,
  ProjectSchema, ProviderInterfaceSchema, ProviderWithInterfacesSchema,
  SessionParamsSchema, UsageSchema, UserSettingsSchema,
} from '@/shared/models'
import { ModelWriteInputSchema, ProviderInterfaceInputSchema, ProviderWriteInputSchema } from '@/shared/api'
import { provider } from './provider-fixtures'

describe('models schemas', () => {
  it('distinguishes undefined and 0 in usage', () => {
    const u = UsageSchema.parse({ prompt: 10, completion: 0 })
    expect(u.completion).toBe(0)
    expect(u.cached).toBeUndefined()
  })

  it('parses a streaming message with null parent', () => {
    const m = MessageSchema.parse({
      id: 1, session_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: [],
      provider_id: 2, model_id: 'gpt-5.1', usage: null, status: 'streaming', error: null, created_at: 0,
    })
    expect(m.parent_id).toBeNull()
  })

  it('never carries an api key on Provider DTOs', () => {
    expect(ProviderWithInterfacesSchema.safeParse(provider).success).toBe(true)
    expect(ProviderWithInterfacesSchema.safeParse({ ...provider, api_key: 'leak' }).success).toBe(false)
  })

  it('defaults existing provider DTOs to custom', () => {
    const { kind: _kind, ...legacyProvider } = provider
    expect(ProviderWithInterfacesSchema.parse(legacyProvider)).toMatchObject({ kind: 'custom' })
  })

  it('requires a public OAuth summary for Codex providers', () => {
    expect(() => ProviderWithInterfacesSchema.parse({
      id: 2,
      user_id: 1,
      name: 'Codex',
      kind: 'codex-oauth',
      has_key: false,
      enabled: true,
      default_interface_id: 20,
      credential_version: 1,
      models_dev_provider_id: 'openai',
      models_dev_provider_source: 'manual',
      interfaces: [{ id: 20, provider_id: 2, protocol: 'responses', base_url: 'https://chatgpt.com/backend-api/codex', native_files: false, created_at: 0 }],
      created_at: 0,
    })).toThrow()
  })

  it('rejects token-shaped fields from public Codex OAuth summaries', () => {
    expect(() => ProviderWithInterfacesSchema.parse({
      id: 2,
      user_id: 1,
      name: 'Codex',
      kind: 'codex-oauth',
      has_key: false,
      enabled: true,
      default_interface_id: 20,
      credential_version: 1,
      models_dev_provider_id: 'openai',
      models_dev_provider_source: 'manual',
      interfaces: [{ id: 20, provider_id: 2, protocol: 'responses', base_url: 'https://chatgpt.com/backend-api/codex', native_files: false, created_at: 0 }],
      oauth: { status: 'connected', account_email: 'me@example.com', access_expires_at: 1, last_error: null, access_token: 'forbidden' },
      created_at: 0,
    })).toThrow()
  })

  it('defaults settings.plugins to an empty map', () => {
    expect(UserSettingsSchema.parse({})).toEqual({ plugins: {} })
  })

  it('accepts partial session params', () => {
    expect(SessionParamsSchema.parse({ temperature: 0.7 })).toEqual({ temperature: 0.7 })
  })

  it('defines only the four supported provider interface protocols', () => {
    expect(InterfaceProtocolSchema.options).toEqual([
      'responses', 'chat-completions', 'anthropic', 'vertex-compatible',
    ])
  })

  it('parses a provider interface without any credential field', () => {
    expect(ProviderInterfaceSchema.parse({
      id: 4,
      provider_id: 2,
      protocol: 'responses',
      base_url: 'https://api.example.test/v1',
      native_files: true,
      created_at: 0,
    })).toMatchObject({ id: 4, protocol: 'responses', native_files: true })
  })

  it('rejects an API key on a provider interface DTO', () => {
    expect(ProviderInterfaceSchema.safeParse({
      id: 4,
      provider_id: 2,
      protocol: 'responses',
      base_url: 'https://api.example.test/v1',
      native_files: true,
      created_at: 0,
      api_key: 'leak',
    }).success).toBe(false)
  })

  it('rejects native Files for vertex-compatible response interfaces', () => {
    expect(ProviderInterfaceSchema.safeParse({
      id: 4,
      provider_id: 2,
      protocol: 'vertex-compatible',
      base_url: 'https://vertex.example.test/v1',
      native_files: true,
      created_at: 0,
    }).success).toBe(false)
  })

  it('uses a submitted protocol as the atomic provider default', () => {
    expect(ProviderWriteInputSchema.parse({
      name: 'Gateway',
      interfaces: [
        { protocol: 'responses', base_url: 'https://api.example.test/responses' },
        { protocol: 'anthropic', base_url: 'https://api.example.test/anthropic' },
      ],
      default_protocol: 'anthropic',
    })).toMatchObject({ default_protocol: 'anthropic' })
  })

  it('validates strict atomic provider and model inputs', () => {
    expect(ProviderInterfaceInputSchema.safeParse({
      protocol: 'responses',
      base_url: 'https://api.example.test/v1',
      ignored: true,
    }).success).toBe(false)
    expect(ProviderInterfaceInputSchema.safeParse({
      protocol: 'vertex-compatible',
      base_url: 'https://vertex.example.test/v1',
      native_files: true,
    }).success).toBe(false)
    expect(ProviderWriteInputSchema.safeParse({
      name: 'Gateway',
      interfaces: [{ protocol: 'responses', base_url: 'https://api.example.test/v1' }],
      default_protocol: 'responses',
      ignored: true,
    }).success).toBe(false)
    expect(ModelWriteInputSchema.parse({
      model_id: 'gpt-5',
      metadata_override: { reasoning: false, cost: { input: 0 } },
    })).toMatchObject({ model_id: 'gpt-5', metadata_override: { reasoning: false, cost: { input: 0 } } })
    expect(ModelWriteInputSchema.safeParse({
      model_id: 'gpt-5',
      metadata_override: { reasoning: false, cost: { input: 0 } },
      ignored: true,
    }).success).toBe(false)
  })

  it('parses indexed model query filters and a cursor page', () => {
    expect(ModelQuerySchema.parse({ vision: true, min_context: 262144, limit: 50 }))
      .toMatchObject({ vision: true, min_context: 262144, limit: 50 })
    expect(ModelPageSchema.parse({ models: [], next_cursor: null })).toEqual({ models: [], next_cursor: null })
  })

  it('treats explicit null reasoning_effort as Auto, independent of reasoning_enabled', () => {
    expect(SessionParamsSchema.parse({ reasoning_enabled: true, reasoning_effort: null }))
      .toEqual({ reasoning_enabled: true, reasoning_effort: null })
  })

  it('accepts an explicit string reasoning_effort', () => {
    expect(SessionParamsSchema.parse({ reasoning_effort: 'xhigh' })).toEqual({ reasoning_effort: 'xhigh' })
  })

  it('rejects an out-of-enum reasoning_effort', () => {
    expect(SessionParamsSchema.safeParse({ reasoning_effort: 'turbo' }).success).toBe(false)
  })

  it('parses a Project with only name required', () => {
    expect(ProjectSchema.parse({
      id: 1, user_id: 1, name: 'Design', icon_attachment_id: null, system_prompt: null,
      provider_id: null, model_id: null, params: null,
      created_at: 1, updated_at: 1,
    }).name).toBe('Design')
  })
})
