import { describe, expect, it } from 'vitest'
import {
  MessageSchema, ModelCapabilitiesSchema, ProjectSchema, ProtocolSchema, ProviderSchema,
  SessionParamsSchema, UsageSchema, UserSettingsSchema,
} from '@/shared/models'

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
    expect(ProviderSchema.safeParse({
      id: 1, user_id: 1, name: 'x', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1',
      has_key: true, extra: null, enabled: true, created_at: 0, api_key: 'leak',
    }).success).toBe(false)
  })

  it('defaults settings.plugins to an empty map', () => {
    expect(UserSettingsSchema.parse({})).toEqual({ plugins: {} })
  })

  it('accepts partial session params', () => {
    expect(SessionParamsSchema.parse({ temperature: 0.7 })).toEqual({ temperature: 0.7 })
  })

  it('accepts the vertex-compatible protocol', () => {
    expect(ProtocolSchema.parse('vertex-compatible')).toBe('vertex-compatible')
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

  it('accepts expanded reasoning efforts and image_output on model capabilities', () => {
    expect(ModelCapabilitiesSchema.parse({ image_output: true, reasoning_efforts: ['low', 'xhigh'] }))
      .toEqual({ image_output: true, reasoning_efforts: ['low', 'xhigh'] })
  })

  it('parses a Project with only name required', () => {
    expect(ProjectSchema.parse({
      id: 1, user_id: 1, name: 'Design', system_prompt: null,
      provider_id: null, model_id: null, params: null,
      created_at: 1, updated_at: 1,
    }).name).toBe('Design')
  })
})
