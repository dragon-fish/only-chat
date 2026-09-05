import { describe, expect, it } from 'vitest'
import { buildModelMessages, buildProviderOptions, type BuildInput } from '@/server/plugins/llm/messages'
import type { Message } from '@/shared/models'
import type { Protocol } from '@/shared/models'

const png = new Uint8Array([137, 80, 78, 71])

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    session_id: 1, parent_id: null, seq: over.id, provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 0, ...over,
  }
}

const path: Message[] = [
  msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: 9 }] }),
  msg({ id: 2, role: 'assistant', parts: [
    { type: 'reasoning', text: 'hmm', providerOptions: { anthropic: { signature: 'SIG' }, openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
    { type: 'text', text: 'a cat' },
  ] }),
  msg({ id: 3, role: 'user', parts: [{ type: 'text', text: 'and now?' }] }),
]

function input(protocol: Protocol): BuildInput {
  return { protocol, systemPrompt: 'be brief', path, images: new Map([[9, { bytes: png, mime: 'image/png' }]]) }
}

describe('buildModelMessages', () => {
  const protocols: Protocol[] = ['openai-completions', 'openai-responses', 'anthropic', 'vertex']

  for (const p of protocols) {
    it(`is byte-identical after a JSON round trip of the parts (${p})`, () => {
      const a = buildModelMessages(input(p))
      const roundTripped: BuildInput = { ...input(p), path: JSON.parse(JSON.stringify(path)) }
      const b = buildModelMessages(roundTripped)
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    })

    it(`matches the golden snapshot (${p})`, () => {
      expect(buildModelMessages(input(p))).toMatchSnapshot()
    })
  }

  it('puts the system prompt first as a system message', () => {
    const out = buildModelMessages(input('openai-responses'))
    expect(out[0]).toMatchObject({ role: 'system', content: 'be brief' })
  })

  it('omits the system message when there is no prompt', () => {
    const out = buildModelMessages({ ...input('anthropic'), systemPrompt: null })
    expect(out[0]!.role).toBe('user')
  })

  it('inlines images as file parts with raw bytes', () => {
    const out = buildModelMessages(input('anthropic'))
    const user = out[1] as { content: Array<{ type: string; mediaType?: string; data?: unknown }> }
    expect(user.content[1]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } })
  })

  it('drops reasoning for openai-completions and keeps it elsewhere', () => {
    const compat = buildModelMessages(input('openai-completions'))
    const anthropic = buildModelMessages(input('anthropic'))
    const types = (m: unknown) => (m as { content: Array<{ type: string }> }).content.map((c) => c.type)
    expect(types(compat[2])).toEqual(['text'])
    expect(types(anthropic[2])).toEqual(['reasoning', 'text'])
  })

  it('places anthropic cache breakpoints on system and last user message only', () => {
    const out = buildModelMessages(input('anthropic')) as Array<{ providerOptions?: unknown }>
    expect(out[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    expect(out[1]!.providerOptions).toBeUndefined()
    expect(out.at(-1)!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    const oa = buildModelMessages(input('openai-responses')) as Array<{ providerOptions?: unknown }>
    expect(oa.every((m) => m.providerOptions === undefined)).toBe(true)
  })

  it('throws when an image is missing from the map', () => {
    expect(() => buildModelMessages({ ...input('anthropic'), images: new Map() })).toThrow(/attachment 9/)
  })
})

describe('buildProviderOptions', () => {
  it('forces store:false on openai responses', () => {
    expect(buildProviderOptions('openai-responses', null, {})).toEqual({ openai: { store: false } })
  })
  it('maps reasoning_effort per protocol', () => {
    expect(buildProviderOptions('openai-responses', { reasoning_effort: 'high' }, { reasoning: true }))
      .toEqual({ openai: { store: false, reasoningEffort: 'high', reasoningSummary: 'auto' } })
    expect(buildProviderOptions('openai-completions', { reasoning_effort: 'low' }, { reasoning: true }))
      .toEqual({ compat: { reasoningEffort: 'low' } })
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'medium' }, { reasoning: true }))
      .toEqual({ anthropic: { effort: 'medium', thinking: { type: 'adaptive', display: 'summarized' } } })
    expect(buildProviderOptions('vertex', { reasoning_effort: 'high' }, { reasoning: true }))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } } })
  })
  it('ignores reasoning_effort when the model has no reasoning capability', () => {
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'high' }, {})).toEqual({})
  })
})
