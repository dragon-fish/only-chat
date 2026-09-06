import { describe, expect, it } from 'vitest'
import { buildModelMessages, buildProviderOptions, requiredAttachmentIds, type AttachmentInput, type BuildInput } from '@/server/plugins/llm/messages'
import type { Message, ModelCapabilities } from '@/shared/models'
import type { Protocol } from '@/shared/models'

const png = new Uint8Array([137, 80, 78, 71])
const inlinePng: AttachmentInput = { mime: 'image/png', data: { type: 'data', data: png } }

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    session_id: 1, parent_id: null, seq: over.id, provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 0, ...over,
  }
}

const path: Message[] = [
  msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: 9 }] }),
  msg({ id: 2, role: 'assistant', parts: [
    { type: 'reasoning', text: 'hmm', providerOptions: {
      anthropic: { signature: 'SIG', redactedData: 'RED' },
      openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' },
    } },
    { type: 'text', text: 'a cat', providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } },
    { type: 'tool_call', id: 'call_1', name: 'lookup', args: { q: 'cat' }, providerOptions: { google: { thoughtSignature: 'TS_TOOL' } } },
    { type: 'tool_result', call_id: 'call_1', name: 'lookup', content: { ok: true } },
  ] }),
  msg({ id: 3, role: 'user', parts: [{ type: 'text', text: 'and now?' }] }),
]

function input(protocol: Protocol): BuildInput {
  return { protocol, systemPrompt: 'be brief', path, attachments: new Map([[9, inlinePng]]) }
}

/** The assistant message of the fixture path, whichever index the protocol put it at. */
function assistantContent(out: unknown[]): Array<{ type: string; text?: string; providerOptions?: unknown }> {
  const m = out.find((x) => (x as { role: string }).role === 'assistant') as { content: Array<{ type: string }> }
  return m.content
}

const PROTOCOLS: Protocol[] = ['openai-completions', 'openai-responses', 'anthropic', 'vertex', 'vertex-compatible']

describe('buildModelMessages', () => {
  for (const p of PROTOCOLS) {
    it(`is byte-identical and deep-equal after a JSON round trip of the parts (${p})`, () => {
      const a = buildModelMessages(input(p))
      const roundTripped: BuildInput = { ...input(p), path: JSON.parse(JSON.stringify(path)) }
      const b = buildModelMessages(roundTripped)
      expect(b).toEqual(a)
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

  it('sends a provider file pointer as a reference part instead of bytes', () => {
    const reference = { openai: 'file-abc123' }
    const out = buildModelMessages({
      ...input('openai-responses'),
      attachments: new Map([[9, { mime: 'image/png', data: { type: 'reference', reference } }]]),
    })
    const user = out[1] as { content: Array<{ type: string; mediaType?: string; data?: unknown }> }
    expect(user.content[1]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'reference', reference } })
  })

  it('replays reasoning on every protocol, openai-completions included', () => {
    for (const p of PROTOCOLS) {
      const content = assistantContent(buildModelMessages(input(p)))
      expect(content.map((c) => c.type)).toEqual(['reasoning', 'text', 'tool-call'])
      expect(content[0]).toMatchObject({ type: 'reasoning', text: 'hmm' })
    }
  })

  it('replays a plain reasoning text so the compatible protocol can send reasoning_content', () => {
    const plain: Message[] = [
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'q' }] }),
      msg({ id: 2, role: 'assistant', parts: [{ type: 'reasoning', text: 'analysis' }, { type: 'text', text: 'answer' }] }),
    ]
    const out = buildModelMessages({ protocol: 'openai-completions', systemPrompt: null, path: plain, attachments: new Map() })
    expect(assistantContent(out)).toContainEqual({ type: 'reasoning', text: 'analysis' })
  })

  it('keeps provider metadata on reasoning, text and tool-call parts verbatim', () => {
    const content = assistantContent(buildModelMessages(input('vertex')))
    expect(content[0]).toMatchObject({ providerOptions: {
      anthropic: { signature: 'SIG', redactedData: 'RED' },
      openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' },
    } })
    expect(content[1]).toMatchObject({ providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } })
    expect(content[2]).toMatchObject({ providerOptions: { google: { thoughtSignature: 'TS_TOOL' } } })
  })

  it('replays an empty reasoning summary that only carries encrypted metadata', () => {
    const encrypted: Message[] = [
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'q' }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
        { type: 'text', text: 'answer' },
      ] }),
    ]
    const out = buildModelMessages({ protocol: 'openai-responses', systemPrompt: null, path: encrypted, attachments: new Map() })
    expect(assistantContent(out)[0]).toEqual({
      type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } },
    })
  })

  it('drops a part that carries neither text nor metadata', () => {
    const empty: Message[] = [
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'q' }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'reasoning', text: '' },
        { type: 'text', text: '' },
        { type: 'text', text: 'answer' },
      ] }),
    ]
    const out = buildModelMessages({ protocol: 'anthropic', systemPrompt: null, path: empty, attachments: new Map() })
    expect(assistantContent(out)).toEqual([{ type: 'text', text: 'answer' }])
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
    expect(() => buildModelMessages({ ...input('anthropic'), attachments: new Map() })).toThrow(/attachment 9/)
  })
})

describe('requiredAttachmentIds', () => {
  const generated: Message[] = [
    ...path,
    msg({ id: 4, role: 'assistant', parts: [{ type: 'text', text: 'here' }, { type: 'image', attachment_id: 77 }] }),
    msg({ id: 5, role: 'user', parts: [{ type: 'image', attachment_id: 9 }, { type: 'image', attachment_id: 10 }] }),
  ]

  it('names every user image once, in path order', () => {
    expect([...requiredAttachmentIds(generated)]).toEqual([9, 10])
  })

  /**
   * The invariant this function exists for: a generated image is dropped by `assistantParts`, so
   * asking for its bytes would upload model output to the provider and fail the turn on an R2 read
   * nothing needed. Asserted against the builder's own output rather than restated by hand.
   */
  it('matches exactly the ids the built request asks for', () => {
    const ids = requiredAttachmentIds(generated)
    expect(ids.has(77)).toBe(false)
    // Both directions at once: an id the builder wants but was not given makes it throw, and every
    // file part it does emit is tagged with the id it came from, so nothing wider can slip through.
    const tagged = (id: number): AttachmentInput => ({ mime: 'image/png', data: { type: 'data', data: new Uint8Array([id]) } })
    const out = buildModelMessages({
      protocol: 'anthropic', systemPrompt: null, path: generated,
      attachments: new Map([...ids].map((id) => [id, tagged(id)])),
    })
    const parts = out.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; data?: unknown }>) : []))
    const emitted = parts.filter((p) => p.type === 'file').map((p) => (p.data as { data: Uint8Array }).data[0])
    expect([...new Set(emitted)].sort((a, b) => a! - b!)).toEqual([...ids].sort((a, b) => a - b))
  })
})

const REASONING: ModelCapabilities = { reasoning: true }
const CAN_DISABLE: ModelCapabilities = { reasoning: true, reasoning_can_disable: true }

describe('buildProviderOptions', () => {
  it('forces store:false on openai responses', () => {
    expect(buildProviderOptions('openai-responses', null, {})).toEqual({ openai: { store: false } })
  })

  it('sends nothing reasoning-related for a model without the capability', () => {
    for (const p of PROTOCOLS) {
      const opts = buildProviderOptions(p, { reasoning_effort: 'high' }, {})
      expect(JSON.stringify(opts)).not.toContain('high')
    }
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'high' }, {})).toEqual({})
  })

  it('enables reasoning with no effort for an explicit Auto', () => {
    const auto = { reasoning_enabled: true, reasoning_effort: null } as const
    expect(buildProviderOptions('openai-responses', auto, REASONING))
      .toEqual({ openai: { store: false, reasoningSummary: 'auto' } })
    expect(buildProviderOptions('openai-completions', auto, REASONING)).toEqual({})
    expect(buildProviderOptions('anthropic', auto, REASONING))
      .toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
    expect(buildProviderOptions('vertex', auto, REASONING))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true } } })
  })

  it('treats an inherited-empty reasoning setting as enabled', () => {
    // Nothing was ever chosen: reasoning stays on, and the protocol still asks for its summary.
    expect(buildProviderOptions('openai-responses', {}, REASONING))
      .toEqual({ openai: { store: false, reasoningSummary: 'auto' } })
    expect(buildProviderOptions('vertex', {}, REASONING))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true } } })
  })

  it('maps an explicit effort per protocol', () => {
    expect(buildProviderOptions('openai-responses', { reasoning_effort: 'high' }, REASONING))
      .toEqual({ openai: { store: false, reasoningSummary: 'auto', reasoningEffort: 'high' } })
    expect(buildProviderOptions('openai-completions', { reasoning_effort: 'low' }, REASONING))
      .toEqual({ compat: { reasoningEffort: 'low' } })
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'medium' }, REASONING))
      .toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'medium' } })
    expect(buildProviderOptions('vertex', { reasoning_effort: 'high' }, REASONING))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } } })
    // The Vertex-compatible gateways share Gemini's reasoning mapping (spec §5.5).
    expect(buildProviderOptions('vertex-compatible', { reasoning_effort: 'high' }, REASONING))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } } })
  })

  it('never forwards an effort Anthropic does not accept', () => {
    // `minimal` and `ultra` are valid in our slider but absent from Anthropic's effort enum, even
    // when the model itself declares them — the protocol, not the capability list, rejects these.
    const caps: ModelCapabilities = { reasoning: true, reasoning_efforts: ['minimal', 'ultra'] }
    for (const effort of ['minimal', 'ultra'] as const) {
      const opts = buildProviderOptions('anthropic', { reasoning_effort: effort }, caps)
      expect(opts).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
      expect(JSON.stringify(opts)).not.toContain(effort)
    }
  })

  it('never forwards a thinking level Gemini does not accept', () => {
    // Gemini's thinkingLevel enum stops at `high`; the request stays a thinking request regardless.
    const caps: ModelCapabilities = { reasoning: true, reasoning_efforts: ['xhigh', 'max', 'ultra'] }
    for (const protocol of ['vertex', 'vertex-compatible'] as const) {
      for (const effort of ['xhigh', 'max', 'ultra'] as const) {
        const opts = buildProviderOptions(protocol, { reasoning_effort: effort }, caps)
        expect(opts).toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true } } })
        expect(JSON.stringify(opts)).not.toContain(effort)
      }
    }
  })

  it('sends only an effort the model declares, and falls back to Auto for one it does not', () => {
    const caps: ModelCapabilities = { reasoning: true, reasoning_efforts: ['low', 'high'] }
    expect(buildProviderOptions('openai-responses', { reasoning_effort: 'high' }, caps))
      .toEqual({ openai: { store: false, reasoningSummary: 'auto', reasoningEffort: 'high' } })
    // `medium` is not declared: reasoning stays on, the stale level is simply not sent.
    expect(buildProviderOptions('openai-responses', { reasoning_effort: 'medium' }, caps))
      .toEqual({ openai: { store: false, reasoningSummary: 'auto' } })
    expect(buildProviderOptions('openai-completions', { reasoning_effort: 'medium' }, caps)).toEqual({})
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'medium' }, caps))
      .toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
    expect(buildProviderOptions('vertex', { reasoning_effort: 'medium' }, caps))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true } } })
  })

  it('keeps the effort when the model declares no level list at all', () => {
    // An absent or empty declaration means "undeclared", never "nothing allowed".
    for (const caps of [REASONING, { reasoning: true, reasoning_efforts: [] } as ModelCapabilities]) {
      expect(buildProviderOptions('openai-responses', { reasoning_effort: 'medium' }, caps))
        .toEqual({ openai: { store: false, reasoningSummary: 'auto', reasoningEffort: 'medium' } })
    }
  })

  it('omits the disable value when the model cannot turn reasoning off', () => {
    const off = { reasoning_enabled: false } as const
    expect(buildProviderOptions('openai-responses', off, REASONING)).toEqual({ openai: { store: false } })
    expect(buildProviderOptions('openai-completions', off, REASONING)).toEqual({})
    expect(buildProviderOptions('anthropic', off, REASONING)).toEqual({})
    expect(buildProviderOptions('vertex', off, REASONING)).toEqual({})
  })

  it('sends the protocol disable value when the model can turn reasoning off', () => {
    const off = { reasoning_enabled: false } as const
    expect(buildProviderOptions('openai-responses', off, CAN_DISABLE))
      .toEqual({ openai: { store: false, reasoningEffort: 'none' } })
    expect(buildProviderOptions('openai-completions', off, CAN_DISABLE)).toEqual({})
    expect(buildProviderOptions('anthropic', off, CAN_DISABLE))
      .toEqual({ anthropic: { thinking: { type: 'disabled' } } })
    expect(buildProviderOptions('vertex', off, CAN_DISABLE))
      .toEqual({ googleVertex: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } })
  })

  it('ignores an effort once reasoning is explicitly disabled', () => {
    const off = { reasoning_enabled: false, reasoning_effort: 'high' } as const
    expect(buildProviderOptions('openai-responses', off, CAN_DISABLE))
      .toEqual({ openai: { store: false, reasoningEffort: 'none' } })
    expect(buildProviderOptions('anthropic', off, CAN_DISABLE))
      .toEqual({ anthropic: { thinking: { type: 'disabled' } } })
  })

  it('asks Gemini for the image modality only when the model declares image output', () => {
    const caps: ModelCapabilities = { image_output: true }
    for (const protocol of ['vertex', 'vertex-compatible'] as const) {
      expect(buildProviderOptions(protocol, null, caps))
        .toEqual({ googleVertex: { responseModalities: ['TEXT', 'IMAGE'] } })
    }
    // Reasoning and image output are independent settings on the same options object.
    expect(buildProviderOptions('vertex', { reasoning_effort: 'high' }, { ...caps, reasoning: true }))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' }, responseModalities: ['TEXT', 'IMAGE'] } })
  })

  it('never asks for image output from a model that does not declare it', () => {
    // The capability is configured, never inferred from a model id (spec §4.4).
    for (const protocol of PROTOCOLS) {
      for (const caps of [{}, REASONING, CAN_DISABLE] as ModelCapabilities[]) {
        expect(JSON.stringify(buildProviderOptions(protocol, { reasoning_enabled: false }, caps))).not.toContain('IMAGE')
        expect(JSON.stringify(buildProviderOptions(protocol, null, caps))).not.toContain('IMAGE')
      }
    }
  })

  it('leaves the non-Gemini protocols alone for image output', () => {
    // Only the Google protocols carry a modality switch; the rest send nothing extra (spec §5.8).
    const caps: ModelCapabilities = { image_output: true }
    expect(buildProviderOptions('openai-responses', null, caps)).toEqual({ openai: { store: false } })
    expect(buildProviderOptions('openai-completions', null, caps)).toEqual({})
    expect(buildProviderOptions('anthropic', null, caps)).toEqual({})
  })
})
