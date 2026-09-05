import { describe, expect, it } from 'vitest'
import { MessageSchema, ProviderSchema, SessionParamsSchema, UsageSchema, UserSettingsSchema } from '@/shared/models'

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
})
