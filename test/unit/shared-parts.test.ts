import { describe, expect, it } from 'vitest'
import { PartSchema, PartsSchema, type Part } from '@/shared/parts'

describe('PartSchema', () => {
  it('round-trips every part type', () => {
    const parts: Part[] = [
      { type: 'text', text: 'hi' },
      { type: 'image', attachment_id: 7 },
      { type: 'reasoning', text: 'thinking', providerOptions: { anthropic: { signature: 'SIG' } } },
      { type: 'tool_call', id: 'c1', name: 'get_weather', args: { city: 'Tokyo' } },
      { type: 'tool_result', call_id: 'c1', name: 'get_weather', content: { tempC: 21 } },
    ]
    expect(PartsSchema.parse(JSON.parse(JSON.stringify(parts)))).toEqual(parts)
  })

  it('rejects unknown part types', () => {
    expect(PartSchema.safeParse({ type: 'video', url: 'x' }).success).toBe(false)
  })

  it('keeps reasoning providerOptions optional', () => {
    expect(PartSchema.parse({ type: 'reasoning', text: '' })).toEqual({ type: 'reasoning', text: '' })
  })

  it('accepts providerOptions on a text part', () => {
    expect(PartSchema.parse({ type: 'text', text: 'ok', providerOptions: { google: { thoughtSignature: 'sig' } } }))
      .toHaveProperty('providerOptions')
  })

  it('accepts providerOptions on a tool_call part', () => {
    expect(PartSchema.parse({
      type: 'tool_call', id: 'c1', name: 'get_weather', args: {},
      providerOptions: { google: { thoughtSignature: 'sig' } },
    })).toHaveProperty('providerOptions')
  })
})
