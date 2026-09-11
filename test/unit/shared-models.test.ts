import { describe, expect, it } from 'vitest'
import {
  InterfaceProtocolSchema, MessageSchema, ModelQuerySchema,
  ProjectSchema, ProviderInterfaceSchema, ProviderWithInterfacesSchema,
  ConversationParamsSchema, ConversationSchema, UsageSchema, UserSettingsSchema,
} from '@/shared/models'
import { ModelWriteInputSchema, ProviderInterfaceInputSchema, ProviderWriteInputSchema } from '@/shared/api'
import { provider } from './provider-fixtures'

describe('models schemas', () => {
  it('parses a conversation with its immutable tool selection', () => {
    expect(ConversationSchema.parse({
      id: 7, user_id: 1, project_id: null, title: 'legacy', head_message_id: 12,
      provider_id: null, model_id: null, system_prompt: null, params: null,
      tools: ['ask_user'], tools_enabled: true, created_at: 0, updated_at: 1, archived_at: null,
    })).toMatchObject({ id: 7, title: 'legacy', tools: ['ask_user'] })
  })
  it('distinguishes undefined and 0 in usage', () => {
    const u = UsageSchema.parse({ prompt: 10, completion: 0 })
    expect(u.completion).toBe(0)
    expect(u.cached).toBeUndefined()
  })

  it('parses a streaming message with null parent', () => {
    const m = MessageSchema.parse({
      id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: [],
      provider_id: 2, model_id: 'gpt-5.1', usage: null, status: 'streaming', error: null, created_at: 0,
    })
    expect(m.parent_id).toBeNull()
    expect(m.conversation_id).toBe(1)
  })

  it('never carries an api key on Provider DTOs', () => {
    expect(ProviderWithInterfacesSchema.safeParse(provider).success).toBe(true)
    expect(ProviderWithInterfacesSchema.safeParse({ ...provider, api_key: 'leak' }).success).toBe(false)
  })

  it('defaults settings.plugins to an empty map', () => {
    expect(UserSettingsSchema.parse({})).toEqual({ plugins: {} })
  })

  it('accepts partial conversation params', () => {
    expect(ConversationParamsSchema.parse({ temperature: 0.7 })).toEqual({ temperature: 0.7 })
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

  it('parses the local model filter state', () => {
    expect(ModelQuerySchema.parse({ vision: true, min_context: 262144 }))
      .toMatchObject({ vision: true, min_context: 262144 })
  })

  it('treats explicit null reasoning_effort as Auto, independent of reasoning_enabled', () => {
    expect(ConversationParamsSchema.parse({ reasoning_enabled: true, reasoning_effort: null }))
      .toEqual({ reasoning_enabled: true, reasoning_effort: null })
  })

  it('accepts an explicit string reasoning_effort', () => {
    expect(ConversationParamsSchema.parse({ reasoning_effort: 'xhigh' })).toEqual({ reasoning_effort: 'xhigh' })
  })

  it('rejects an out-of-enum reasoning_effort', () => {
    expect(ConversationParamsSchema.safeParse({ reasoning_effort: 'turbo' }).success).toBe(false)
  })

  it('parses a Project with only name required', () => {
    expect(ProjectSchema.parse({
      id: 1, user_id: 1, name: 'Design', icon_attachment_id: null, system_prompt: null,
      provider_id: null, model_id: null, params: null,
      created_at: 1, updated_at: 1,
    }).name).toBe('Design')
  })
})
