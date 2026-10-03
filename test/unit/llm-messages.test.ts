import { describe, expect, it } from 'vitest'
import { buildModelMessages, buildProviderOptions, GONE, interjectedUserMessage, renderTaskNotification, requiredAttachmentIds, toolAttachmentsMessage, toolDeliveredAttachmentIds, type AttachmentInput, type BuildInput } from '@/server/plugins/llm/messages'
import { isNotificationOnly, TOOL_ATTACHMENTS_KEY, toolResultPart, type TaskNotificationPart, type ToolResultPart } from '@/shared/parts'
import type { Message } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { InterfaceProtocol } from '@/shared/models'
import { fileLabeler } from '@/plugins/file-reader/server/service'
import { VisibleAssets } from '@/plugins/file-reader/server/visible'

/** The file reader's own labels, over a turn that has seen exactly these prefixes. */
function labelerFor(prefixes: ReadonlyMap<number, string>, hint = '') {
  const visible = new VisibleAssets()
  for (const [id, prefix] of prefixes) visible.add(id, { prefix, filename: null })
  return fileLabeler(visible, () => hint)
}

const png = new Uint8Array([137, 80, 78, 71])
const inlinePng: AttachmentInput = { mime: 'image/png', data: { type: 'data', data: png } }

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    conversation_id: 1, parent_id: null, seq: over.id, provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 0, ...over,
  }
}

const path: Message[] = [
  msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: 9 }] }),
  msg({ id: 2, role: 'assistant', parts: [
    { type: 'reasoning', text: 'hmm', providerOptions: {
      anthropic: { signature: 'SIG', redactedData: 'RED' },
      responses: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' },
    } },
    { type: 'text', text: 'a cat', providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } },
    { type: 'tool_call', id: 'call_1', name: 'lookup', args: { q: 'cat' }, providerOptions: { google: { thoughtSignature: 'TS_TOOL' } } },
    { type: 'tool_result', call_id: 'call_1', name: 'lookup', content: { ok: true } },
    // A reply that ran to its own finish ends on text. Do not drop this: ending on a `tool_result`
    // is the mark of a turn that was taken over, and the fixture would then be that instead.
    { type: 'text', text: 'yes, a cat' },
  ] }),
  msg({ id: 3, role: 'user', parts: [{ type: 'text', text: 'and now?' }] }),
]

function input(protocol: InterfaceProtocol): BuildInput {
  return { protocol, systemPrompt: 'be brief', path, attachments: new Map([[9, inlinePng]]), labeler: labelerFor(new Map([[9, '3f9a2c1e']])) }
}

/** The assistant message of the fixture path, whichever index the protocol put it at. */
function assistantContent(out: unknown[]): Array<{ type: string; text?: string; providerOptions?: unknown }> {
  const m = out.find((x) => (x as { role: string }).role === 'assistant') as { content: Array<{ type: string }> }
  return m.content
}

const PROTOCOLS: InterfaceProtocol[] = ['chat-completions', 'responses', 'anthropic', 'vertex-compatible']

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
    const out = buildModelMessages(input('responses'))
    expect(out[0]).toMatchObject({ role: 'system', content: 'be brief' })
  })

  it('omits the system message when there is no prompt', () => {
    const out = buildModelMessages({ ...input('anthropic'), systemPrompt: null })
    expect(out[0]!.role).toBe('user')
  })

  it('inlines images as file parts with raw bytes', () => {
    const out = buildModelMessages(input('anthropic'))
    const user = out[1] as { content: Array<{ type: string; mediaType?: string; data?: unknown }> }
    expect(user.content[2]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } })
  })

  it('sends a provider file pointer as a reference part instead of bytes', () => {
    const reference = { openai: 'file-abc123' }
    const out = buildModelMessages({
      ...input('responses'),
      attachments: new Map([[9, { mime: 'image/png', data: { type: 'reference', reference } }]]),
    })
    const user = out[1] as { content: Array<{ type: string; mediaType?: string; data?: unknown }> }
    expect(user.content[2]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'reference', reference } })
  })

  it('replays reasoning on every protocol, chat-completions included', () => {
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
    const out = buildModelMessages({ protocol: 'chat-completions', systemPrompt: null, path: plain, attachments: new Map() })
    expect(assistantContent(out)).toContainEqual({ type: 'reasoning', text: 'analysis' })
  })

  it('keeps only metadata namespaces understood by the selected protocol', () => {
    const content = assistantContent(buildModelMessages(input('vertex-compatible')))
    expect(content[0]).toEqual({ type: 'reasoning', text: 'hmm' })
    expect(content[1]).toMatchObject({ providerOptions: { google: { thoughtSignature: 'TS_TEXT' } } })
    expect(content[2]).toMatchObject({ providerOptions: { google: { thoughtSignature: 'TS_TOOL' } } })
    expect(assistantContent(buildModelMessages(input('responses')))[0]).toEqual({
      type: 'reasoning', text: 'hmm', providerOptions: { responses: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } },
    })
    expect(assistantContent(buildModelMessages(input('anthropic')))[0]).toEqual({
      type: 'reasoning', text: 'hmm', providerOptions: { anthropic: { signature: 'SIG', redactedData: 'RED' } },
    })
    expect(assistantContent(buildModelMessages(input('chat-completions')))[0]).toEqual({ type: 'reasoning', text: 'hmm' })
  })

  it('preserves foreign reasoning as plain assistant context for Anthropic, which requires signed thinking', () => {
    const foreign = [msg({ id: 2, role: 'assistant', parts: [
      { type: 'reasoning', text: 'analysis', providerOptions: { responses: { itemId: 'r1' } } },
      { type: 'text', text: 'answer' },
    ] })]
    const out = buildModelMessages({ protocol: 'anthropic', systemPrompt: null, path: foreign, attachments: new Map() })
    expect(assistantContent(out)).toEqual([{ type: 'text', text: 'analysis' }, { type: 'text', text: 'answer' }])
  })

  it('sends a failed call back as error text, the way the SDK sent it mid-turn', () => {
    const out = buildModelMessages({ protocol: 'responses', systemPrompt: null, attachments: new Map(), path: [msg({ id: 1, role: 'assistant', parts: [
      { type: 'tool_call', id: 'c1', name: 'edit_file', args: { oldText: 'a' } },
      { type: 'tool_result', call_id: 'c1', name: 'edit_file', content: 'path: Required', is_error: true },
    ] })] })
    expect(out[1]).toEqual({ role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'edit_file', output: { type: 'error-text', value: 'path: Required' } },
    ] })
  })

  it('preserves tool results between assistant segments instead of moving them after later reasoning', () => {
    const ordered = [msg({ id: 2, role: 'assistant', parts: [
      { type: 'reasoning', text: 'first' },
      { type: 'tool_call', id: 'c1', name: 'lookup', args: {} },
      { type: 'tool_result', call_id: 'c1', name: 'lookup', content: { ok: true } },
      { type: 'reasoning', text: 'second' },
      { type: 'text', text: 'answer' },
    ] })]
    const out = buildModelMessages({ protocol: 'responses', systemPrompt: null, path: ordered, attachments: new Map() })
    expect(out.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(out.map(message => Array.isArray(message.content) ? message.content.map(part => part.type) : [])).toEqual([
      ['reasoning', 'tool-call'], ['tool-result'], ['reasoning', 'text'],
    ])
  })

  for (const protocol of PROTOCOLS) {
    it(`keeps an ask_user result before the following user turn (${protocol})`, () => {
      const conversation = [
        msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'start' }] }),
        msg({ id: 2, role: 'assistant', parent_id: 1, parts: [
          { type: 'tool_call', id: 'ask-1', name: 'ask_user', args: { questions: [] } },
          { type: 'tool_result', call_id: 'ask-1', name: 'ask_user', content: { status: 'cancelled', message: '用户选择了取消回答' } },
        ] }),
        msg({ id: 3, role: 'user', parent_id: 2, parts: [{ type: 'text', text: 'continue normally' }] }),
      ]
      const out = buildModelMessages({ protocol, systemPrompt: null, path: conversation, attachments: new Map() })
      expect(out.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
      expect(out[2]).toMatchObject({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'ask-1', toolName: 'ask_user', output: { type: 'json', value: { status: 'cancelled' } } }],
      })
    })
  }

  it('replays an empty reasoning summary that only carries encrypted metadata', () => {
    const encrypted: Message[] = [
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'q' }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
        { type: 'text', text: 'answer' },
      ] }),
    ]
    const out = buildModelMessages({ protocol: 'responses', systemPrompt: null, path: encrypted, attachments: new Map() })
    expect(assistantContent(out)[0]).toEqual({
      type: 'reasoning', text: '', providerOptions: { responses: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } },
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
    const oa = buildModelMessages(input('responses')) as Array<{ providerOptions?: unknown }>
    expect(oa.every((m) => m.providerOptions === undefined)).toBe(true)
  })

  it('throws when an image is missing from the map', () => {
    expect(() => buildModelMessages({ ...input('anthropic'), attachments: new Map() })).toThrow(/attachment 9/)
  })

  it('leads the first user message with the preamble and leaves later ones alone', () => {
    const out = buildModelMessages({ ...input('anthropic'), preamble: '<memory-catalog />' }) as Array<{ role: string; content: unknown }>
    const users = out.filter((m) => m.role === 'user') as Array<{ content: Array<{ type: string; text?: string }> }>
    expect(users[0]!.content[0]).toEqual({ type: 'text', text: '<memory-catalog />' })
    expect(users[0]!.content[1]).toEqual({ type: 'text', text: 'look' })
    expect(users.at(-1)!.content).toEqual([{ type: 'text', text: 'and now?' }])
  })

  it('ends a user message with its notes as reminders, and leaves the others alone', () => {
    const noted = path.map((m) => (m.id === 3 ? { ...m, notes: [{ plugin: 'a', text: 'first' }, { plugin: 'b', text: 'second' }] } : m))
    const out = buildModelMessages({ ...input('responses'), path: noted }) as Array<{ role: string; content: unknown }>
    const users = out.filter((m) => m.role === 'user') as Array<{ content: Array<{ type: string; text?: string }> }>
    expect(users.at(-1)!.content).toEqual([
      { type: 'text', text: 'and now?' },
      { type: 'text', text: '<system-reminder>\nfirst\n</system-reminder>' },
      { type: 'text', text: '<system-reminder>\nsecond\n</system-reminder>' },
    ])
    expect(users[0]!.content.some((part) => part.text?.includes('system-reminder'))).toBe(false)
  })

  it('keeps the preamble ahead of an interruption note when the first reply was cut short', () => {
    const interrupted: Message[] = [
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'first' }] }),
      msg({ id: 2, role: 'assistant', status: 'aborted', parts: [] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: 'second' }] }),
    ]
    const out = buildModelMessages({ protocol: 'anthropic', systemPrompt: null, path: interrupted, attachments: new Map(), preamble: 'P' }) as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    expect(out).toHaveLength(1)
    expect(out[0]!.content[0]).toEqual({ type: 'text', text: 'P' })
    expect(out[0]!.content[1]).toEqual({ type: 'text', text: 'first' })
    expect(out[0]!.content.filter((part) => part.text === 'P')).toHaveLength(1)
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
      labeler: labelerFor(new Map([[9, '00000009'], [10, '0000000a'], [77, '0000004d']])),
    })
    const parts = out.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; data?: unknown }>) : []))
    const emitted = parts.filter((p) => p.type === 'file').map((p) => (p.data as { data: Uint8Array }).data[0])
    expect([...new Set(emitted)].sort((a, b) => a! - b!)).toEqual([...ids].sort((a, b) => a - b))
  })
})

const REASONING: ModelMetadata = { reasoning: true }
const CAN_DISABLE: ModelMetadata = { reasoning: true, reasoning_options: [{ type: 'toggle' }] }

describe('buildProviderOptions', () => {
  it('leaves Responses reasoning unspecified without model metadata', () => {
    expect(buildProviderOptions('responses', null, {})).toEqual({})
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
    expect(buildProviderOptions('responses', auto, REASONING))
      .toEqual({})
    expect(buildProviderOptions('chat-completions', auto, REASONING)).toEqual({})
    expect(buildProviderOptions('anthropic', auto, REASONING))
      .toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
    expect(buildProviderOptions('vertex-compatible', auto, REASONING))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true } } })
  })

  it('treats an inherited-empty reasoning setting as enabled', () => {
    // An inherited-empty setting leaves the reasoning model's default effort in effect.
    expect(buildProviderOptions('responses', {}, REASONING))
      .toEqual({})
    expect(buildProviderOptions('vertex-compatible', {}, REASONING))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true } } })
  })

  it('maps an explicit effort per protocol', () => {
    expect(buildProviderOptions('responses', { reasoning_effort: 'high' }, REASONING))
      .toEqual({ responses: { reasoningEffort: 'high' } })
    expect(buildProviderOptions('chat-completions', { reasoning_effort: 'low' }, REASONING))
      .toEqual({ compat: { reasoningEffort: 'low' } })
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'medium' }, REASONING))
      .toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'medium' } })
    expect(buildProviderOptions('vertex-compatible', { reasoning_effort: 'high' }, REASONING))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } } })
  })

  it('never forwards an effort Anthropic does not accept', () => {
    // `minimal` and `ultra` are valid in our slider but absent from Anthropic's effort enum, even
    // when the model itself declares them — the protocol, not the capability list, rejects these.
    const caps: ModelMetadata = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['minimal', 'ultra'] }] }
    for (const effort of ['minimal', 'ultra'] as const) {
      const opts = buildProviderOptions('anthropic', { reasoning_effort: effort }, caps)
      expect(opts).toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
      expect(JSON.stringify(opts)).not.toContain(effort)
    }
  })

  it('never forwards a thinking level Gemini does not accept', () => {
    // Gemini's thinkingLevel enum stops at `high`; the request stays a thinking request regardless.
    const caps: ModelMetadata = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['xhigh', 'max', 'ultra'] }] }
    for (const protocol of ['vertex-compatible'] as const) {
      for (const effort of ['xhigh', 'max', 'ultra'] as const) {
        const opts = buildProviderOptions(protocol, { reasoning_effort: effort }, caps)
        expect(opts).toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true } } })
        expect(JSON.stringify(opts)).not.toContain(effort)
      }
    }
  })

  it('sends only an effort the model declares, and falls back to Auto for one it does not', () => {
    const caps: ModelMetadata = { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }
    expect(buildProviderOptions('responses', { reasoning_effort: 'high' }, caps))
      .toEqual({ responses: { reasoningEffort: 'high' } })
    // `medium` is not declared: reasoning stays on, the stale level is simply not sent.
    expect(buildProviderOptions('responses', { reasoning_effort: 'medium' }, caps))
      .toEqual({})
    expect(buildProviderOptions('chat-completions', { reasoning_effort: 'medium' }, caps)).toEqual({})
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'medium' }, caps))
      .toEqual({ anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } })
    expect(buildProviderOptions('vertex-compatible', { reasoning_effort: 'medium' }, caps))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true } } })
  })

  it('keeps the effort when the model declares no level list at all', () => {
    // An absent or empty declaration means "undeclared", never "nothing allowed".
    for (const caps of [REASONING, { reasoning: true, reasoning_options: [{ type: 'effort', values: [] }] } as ModelMetadata]) {
      expect(buildProviderOptions('responses', { reasoning_effort: 'medium' }, caps))
        .toEqual({ responses: { reasoningEffort: 'medium' } })
    }
  })

  it('omits the disable value when the model cannot turn reasoning off', () => {
    const off = { reasoning_enabled: false } as const
    expect(buildProviderOptions('responses', off, REASONING)).toEqual({})
    expect(buildProviderOptions('chat-completions', off, REASONING)).toEqual({})
    expect(buildProviderOptions('anthropic', off, REASONING)).toEqual({})
    expect(buildProviderOptions('vertex-compatible', off, REASONING)).toEqual({})
  })

  it('sends the protocol disable value when the model can turn reasoning off', () => {
    const off = { reasoning_enabled: false } as const
    expect(buildProviderOptions('responses', off, CAN_DISABLE))
      .toEqual({ responses: { reasoningEffort: 'none' } })
    expect(buildProviderOptions('chat-completions', off, CAN_DISABLE)).toEqual({ compat: { reasoningEffort: 'none' } })
    expect(buildProviderOptions('anthropic', off, CAN_DISABLE))
      .toEqual({ anthropic: { thinking: { type: 'disabled' } } })
    expect(buildProviderOptions('vertex-compatible', off, CAN_DISABLE))
      .toEqual({ googleVertex: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } })
  })

  it('ignores an effort once reasoning is explicitly disabled', () => {
    const off = { reasoning_enabled: false, reasoning_effort: 'high' } as const
    expect(buildProviderOptions('responses', off, CAN_DISABLE))
      .toEqual({ responses: { reasoningEffort: 'none' } })
    expect(buildProviderOptions('anthropic', off, CAN_DISABLE))
      .toEqual({ anthropic: { thinking: { type: 'disabled' } } })
  })

  it('asks Gemini for the image modality only when the model declares image output', () => {
    const caps: ModelMetadata = { modalities: { input: [], output: ['image'] } }
    for (const protocol of ['vertex-compatible'] as const) {
      expect(buildProviderOptions(protocol, null, caps))
        .toEqual({ googleVertex: { responseModalities: ['TEXT', 'IMAGE'] } })
    }
    // Reasoning and image output are independent settings on the same options object.
    expect(buildProviderOptions('vertex-compatible', { reasoning_effort: 'high' }, { ...caps, reasoning: true }))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' }, responseModalities: ['TEXT', 'IMAGE'] } })
  })

  it('never asks for image output from a model that does not declare it', () => {
    // The capability is configured, never inferred from a model id (spec §4.4).
    for (const protocol of PROTOCOLS) {
      for (const caps of [{}, REASONING, CAN_DISABLE] as ModelMetadata[]) {
        expect(JSON.stringify(buildProviderOptions(protocol, { reasoning_enabled: false }, caps))).not.toContain('IMAGE')
        expect(JSON.stringify(buildProviderOptions(protocol, null, caps))).not.toContain('IMAGE')
      }
    }
  })

  it('leaves the non-Gemini protocols alone for image output', () => {
    // Only the Google protocols carry a modality switch; the rest send nothing extra (spec §5.8).
    const caps: ModelMetadata = { modalities: { input: [], output: ['image'] } }
    expect(buildProviderOptions('responses', null, caps)).toEqual({})
    expect(buildProviderOptions('chat-completions', null, caps)).toEqual({})
    expect(buildProviderOptions('anthropic', null, caps)).toEqual({})
  })
})

describe('rolling back to somewhere legal', () => {
  const build = (path: Message[]) => buildModelMessages({
    protocol: 'chat-completions', systemPrompt: null, path, attachments: new Map(),
  })

  it('answers a call nothing ever answered, rather than hiding it', () => {
    // A tool_use with no result beside it cannot be followed by a user message. Dropping it would
    // be legal too, but the model would not see that it reached for something and got nothing.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '查' }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'text', text: '这就去' },
        { type: 'tool_call', id: 'never', name: 'lookup', args: {} },
      ] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '算了' }] }),
    ])
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    const answer = (out[2] as { content: Array<{ toolCallId: string, output: { value: unknown } }> }).content[0]!
    expect(answer.toolCallId).toBe('never')
    // Not an error: an error is a tool that ran and failed, and this one never ran at all.
    expect(answer.output.value).toMatchObject({ interrupted: true })
  })

  it('leaves an answered call exactly as it was', () => {
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '查两个' }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'tool_call', id: 'ok', name: 'lookup', args: {} },
        { type: 'tool_result', call_id: 'ok', name: 'lookup', content: { ok: true } },
      ] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '够了' }] }),
    ])
    const answers = (out[2] as { content: Array<{ output: { value: unknown } }> }).content
    expect(answers[0]!.output.value).toMatchObject({ ok: true })
  })

  it('never leaves two user messages adjacent, whatever the turn between them held', () => {
    // Nothing the hub does or fails to do can produce an illegal prompt from here: every call is
    // answered, and a turn that contributed nothing joins the messages around it.
    const roles = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '第一句' }] }),
      // `done`, not `aborted`: a handoff finalises the silent half of a turn as finished.
      msg({ id: 2, role: 'assistant', parts: [] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '第二句' }] }),
    ]).map(m => m.role)
    expect(roles).toEqual(['user'])
    expect(roles.filter((role, i) => role === 'user' && roles[i + 1] === 'user')).toEqual([])
  })

  it('tells the model a reply that was taken over was not finished', () => {
    // A handoff keeps everything the half-turn produced, so it is stored as `done` and only the
    // marker says otherwise. Without this, the model reads its own unanswered lookup as a turn it
    // chose to end, and the operator's words as a fresh topic rather than an interruption.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '搜一下' }] }),
      msg({ id: 2, role: 'assistant', status: 'done', error: 'interjected', parts: [
        { type: 'tool_call', id: 'c', name: 'lookup', args: {} },
        { type: 'tool_result', call_id: 'c', name: 'lookup', content: { ok: true } },
      ] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '算了' }] }),
    ])
    // That something precedes their words, not what it says — the wording is a decision.
    const last = out.at(-1) as { role: string, content: unknown[] }
    expect(last.role).toBe('user')
    expect(last.content).toEqual([
      { type: 'text', text: expect.any(String) },
      { type: 'text', text: '算了' },
    ])
  })

  it('says nothing about a turn that stopped for an answer', () => {
    // `awaitsHumanToolResult` stops a turn on the tool result, so every ask_user leaves a reply
    // ending on one. Nothing was interrupted; the person simply answered and it went on.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '帮我改改' }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'text', text: '两个方向，选一个' },
        { type: 'tool_call', id: 'q', name: 'ask_user', args: {} },
        { type: 'tool_result', call_id: 'q', name: 'ask_user', content: { answers: [] } },
      ] }),
      msg({ id: 3, role: 'assistant', parts: [{ type: 'text', text: '好的，改完了' }] }),
      msg({ id: 4, role: 'user', parts: [{ type: 'text', text: '确实是好多了' }] }),
    ])
    expect((out.at(-1) as { content: Array<{ text: string }> }).content).toEqual([
      { type: 'text', text: '确实是好多了' },
    ])
  })

  it('does not carry a note past the reply that came after it', () => {
    // Two replies in a row is a legal shape, not a broken one: a single tool exchange spans both
    // rows when a person answers it, the first ending on the result and the second picking up with
    // reasoning. So the note has to expire at the reply after the one it describes — anything
    // further on was said in a conversation that carried on normally.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '开始' }] }),
      msg({ id: 2, role: 'assistant', status: 'aborted', parts: [{ type: 'text', text: '半句' }] }),
      msg({ id: 3, role: 'assistant', parts: [{ type: 'text', text: '答完了' }] }),
      msg({ id: 4, role: 'user', parts: [{ type: 'text', text: '新话题' }] }),
    ])
    expect((out.at(-1) as { content: Array<{ text: string }> }).content).toEqual([
      { type: 'text', text: '新话题' },
    ])
  })

  it('carries a note per interruption when several land in a row', () => {
    // Stop it, say something, stop it again, say something else. Each turn that died before
    // producing anything folds into the message before it, so one user message can end up holding
    // several notes: one at the front for the turn that left work behind, one in front of every
    // sentence that followed a silent one.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '甲' }] }),
      msg({ id: 2, role: 'assistant', status: 'aborted', parts: [{ type: 'text', text: '写到一半' }] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '乙' }] }),
      msg({ id: 4, role: 'assistant', status: 'aborted', parts: [] }),
      msg({ id: 5, role: 'user', parts: [{ type: 'text', text: '丙' }] }),
      msg({ id: 6, role: 'assistant', status: 'done', parts: [] }),
      msg({ id: 7, role: 'user', parts: [{ type: 'text', text: '丁' }] }),
    ])
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    // One note in front of each thing they said, in order.
    const said = (out[2] as { content: Array<{ text: string }> }).content.map(c => c.text)
    expect(said).toEqual([expect.any(String), '乙', expect.any(String), '丙', expect.any(String), '丁'])
  })
})

describe('task notifications', () => {
  const notice: TaskNotificationPart = {
    type: 'task_notification', task_id: 'image_run:12', plugin_id: 'image_generation', tool_call_id: 'call_1',
    status: 'completed', text: 'Generated 1 image(s): asset:5c2e8f10', attachments: [31],
  }

  it('reach the model as a tagged user text block', () => {
    const messages = buildModelMessages({
      protocol: 'responses', systemPrompt: null, attachments: new Map(), labeler: labelerFor(new Map([[31, '5c2e8f10']])),
      path: [msg({ id: 1, role: 'user', parts: [notice] })],
    })
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: renderTaskNotification(notice) }] }])
    expect(renderTaskNotification(notice)).toBe([
      '<task-notification>', '<task-id>image_run:12</task-id>', '<status>completed</status>',
      '<summary>Generated 1 image(s): asset:5c2e8f10</summary>', '</task-notification>',
    ].join('\n'))
  })

  it('does not claim the person interrupted when only notifications arrived mid-turn', () => {
    expect(interjectedUserMessage([notice], new Map(), undefined, false))
      .toEqual({ role: 'user', content: [{ type: 'text', text: renderTaskNotification(notice) }] })
    expect((interjectedUserMessage([{ type: 'text', text: 'hi' }], new Map(), undefined, true).content as Array<{ text: string }>)[0]!.text)
      .toBe('[Request interrupted by user]')
  })

  it('tells a notification-only message from one the person wrote', () => {
    expect(isNotificationOnly([notice])).toBe(true)
    expect(isNotificationOnly([notice, { type: 'text', text: 'and also' }])).toBe(false)
    expect(isNotificationOnly([])).toBe(false)
  })
})

describe('files a tool delivered', () => {
  const reading: Message = msg({ id: 2, role: 'assistant', parts: [
    { type: 'tool_call', id: 'call_r', name: 'read_file', args: { path: '/project/otter.png' } },
    { type: 'tool_result', call_id: 'call_r', name: 'read_file', content: { file: 'asset:5c2e8f10', mime: 'image/png' }, attachments: [9] },
    { type: 'text', text: 'It is an otter.' },
  ] })
  const assets = new Map([[9, '5c2e8f10'], [12, 'b41d07a9']])

  it('follow the tool message as a user message wrapped per result, so every protocol can carry them', () => {
    const out = buildModelMessages({ protocol: 'responses', systemPrompt: null, attachments: new Map([[9, inlinePng]]), labeler: labelerFor(assets), path: [msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'look' }] }), reading] })
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
    expect(out[3]).toEqual(toolAttachmentsMessage([reading.parts[1] as ToolResultPart], new Map([[9, inlinePng]]), labelerFor(assets)))
    expect(out[3]).toEqual({ role: 'user', content: [
      { type: 'text', text: '<tool_attachment call_id="call_r" asset="5c2e8f10">' },
      { type: 'file', mediaType: 'image/png', data: inlinePng.data },
      { type: 'text', text: '</tool_attachment>' },
    ] })
  })

  it('come after the whole batch of parallel results, in one message', () => {
    const pdf: AttachmentInput = { mime: 'application/pdf', data: { type: 'data', data: new TextEncoder().encode('%PDF-1.7') } }
    const out = buildModelMessages({
      protocol: 'responses', systemPrompt: null, attachments: new Map([[9, inlinePng], [12, pdf]]), labeler: labelerFor(assets),
      path: [msg({ id: 1, role: 'assistant', parts: [
        { type: 'tool_call', id: 'a', name: 'read_file', args: {} },
        { type: 'tool_call', id: 'b', name: 'read_file', args: {} },
        { type: 'tool_result', call_id: 'b', name: 'read_file', content: {}, attachments: [12] },
        { type: 'tool_result', call_id: 'a', name: 'read_file', content: {}, attachments: [9] },
      ] })],
    })
    expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'user'])
    expect((out[2]!.content as Array<{ type: string, text?: string, filename?: string }>)).toEqual([
      { type: 'text', text: '<tool_attachment call_id="b" asset="b41d07a9">' },
      { type: 'file', mediaType: 'application/pdf', filename: 'file.pdf', data: pdf.data },
      { type: 'text', text: '</tool_attachment>' },
      { type: 'text', text: '<tool_attachment call_id="a" asset="5c2e8f10">' },
      { type: 'file', mediaType: 'image/png', data: inlinePng.data },
      { type: 'text', text: '</tool_attachment>' },
    ])
  })

  it('are replaced inside the wrapper by what the current model cannot read, without bytes', () => {
    const unreadable: AttachmentInput = { mime: 'audio/mpeg', unavailable: 'unreadable' }
    const message = toolAttachmentsMessage([
      { type: 'tool_result', call_id: 'c', name: 'read_file', content: {}, attachments: [12] },
    ], new Map([[12, unreadable]]), labelerFor(assets))
    expect(message.content).toEqual([
      { type: 'text', text: '<tool_attachment call_id="c" asset="b41d07a9">' },
      { type: 'text', text: 'The current model cannot read audio/mpeg, so the file was not sent.' },
      { type: 'text', text: '</tool_attachment>' },
    ])
  })

  it('say a file is gone instead of failing when its row was purged mid-turn', () => {
    const message = toolAttachmentsMessage([
      { type: 'tool_result', call_id: 'c', name: 'read_file', content: {}, attachments: [99] },
    ], new Map([[99, GONE]]), labelerFor(assets))
    expect(message.content).toEqual([
      { type: 'text', text: '<tool_attachment call_id="c">' },
      { type: 'text', text: 'This file no longer exists.' },
      { type: 'text', text: '</tool_attachment>' },
    ])
  })

  it('may lose their row only when nothing but a tool result names them', () => {
    const path = [
      msg({ id: 1, role: 'user', parts: [{ type: 'image', attachment_id: 9 }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'tool_result', call_id: 'a', name: 'read_file', content: {}, attachments: [9, 12] },
      ] }),
    ]
    expect(toolDeliveredAttachmentIds(path)).toEqual(new Set([12]))
  })

  it('are resolved with the rest of the request', () => {
    expect(requiredAttachmentIds([reading])).toEqual(new Set([9]))
  })

  it('are handed over by the tool under a reserved key that never reaches the stored content', () => {
    expect(toolResultPart('call_r', 'read_file', { file: 'asset:5c2e8f10', [TOOL_ATTACHMENTS_KEY]: [9, 10] }))
      .toEqual({ type: 'tool_result', call_id: 'call_r', name: 'read_file', content: { file: 'asset:5c2e8f10' }, attachments: [9, 10] })
    expect(toolResultPart('call_x', 'web_search', { results: [] }))
      .toEqual({ type: 'tool_result', call_id: 'call_x', name: 'web_search', content: { results: [] } })
  })
})

describe('asset labels', () => {
  const path: Message[] = [
    msg({ id: 1, role: 'user', parts: [
      { type: 'image', attachment_id: 9, filename: 'cat.png' },
      { type: 'file', attachment_id: 12, mime: 'application/pdf', filename: 'report "final".pdf' },
      { type: 'image', attachment_id: 14 },
      { type: 'text', text: 'make it blue' },
    ] }),
    msg({ id: 2, role: 'assistant', parts: [{ type: 'image', attachment_id: 13, artifact_id: 33 }, { type: 'text', text: 'done' }] }),
  ]
  const pdf: AttachmentInput = { mime: 'application/pdf', data: { type: 'data', data: new Uint8Array([37]) } }
  const assets = new Map([[9, '3f9a2c1e'], [12, 'b41d07a9'], [13, '5c2e8f10'], [14, '9a01d3c4']])
  const build = (attachments: Map<number, AttachmentInput>) => buildModelMessages({ protocol: 'responses', systemPrompt: null, path, attachments, labeler: labelerFor(assets) })

  it('name every file by asset and never by id when the file reader labels them', () => {
    const out = build(new Map([[9, inlinePng], [12, pdf], [14, inlinePng]]))
    expect(out[0]).toEqual({ role: 'user', content: [
      { type: 'text', text: '[image asset:3f9a2c1e "cat.png"]' }, { type: 'file', mediaType: 'image/png', data: inlinePng.data },
      { type: 'text', text: '[file asset:b41d07a9 "report \\"final\\".pdf" application/pdf]' },
      // The upstream name says nothing: not the id, not the person's filename.
      { type: 'file', mediaType: 'application/pdf', filename: 'file.pdf', data: pdf.data },
      { type: 'text', text: '[image asset:9a01d3c4]' }, { type: 'file', mediaType: 'image/png', data: inlinePng.data },
      { type: 'text', text: 'make it blue' },
    ] })
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '[generated image asset:5c2e8f10]' }, { type: 'text', text: 'done' }] })
  })

  it('carry the files and nothing about them without a labeler', () => {
    const out = buildModelMessages({ protocol: 'responses', systemPrompt: null, path, attachments: new Map([[9, inlinePng], [12, pdf], [14, inlinePng]]) })
    expect(out[0]).toEqual({ role: 'user', content: [
      { type: 'file', mediaType: 'image/png', data: inlinePng.data },
      { type: 'file', mediaType: 'application/pdf', filename: 'file.pdf', data: pdf.data },
      { type: 'file', mediaType: 'image/png', data: inlinePng.data },
      { type: 'text', text: 'make it blue' },
    ] })
    // A generated image's pixels are never replayed, and with nothing to name it by nothing is said.
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
  })

  it('keep the label and state the limitation for a file the current model cannot read', () => {
    const unreadable: AttachmentInput = { mime: 'application/pdf', unavailable: 'unreadable' }
    const out = build(new Map<number, AttachmentInput>([[9, inlinePng], [12, unreadable], [14, inlinePng]]))
    expect((out[0]!.content as unknown[]).slice(2, 4)).toEqual([
      { type: 'text', text: '[file asset:b41d07a9 "report \\"final\\".pdf" application/pdf]' },
      { type: 'text', text: 'The current model cannot read application/pdf, so the file was not sent.' },
    ])
  })

  it('label what was said mid-turn the way the rebuilt history will', () => {
    expect(interjectedUserMessage([{ type: 'image', attachment_id: 9, filename: 'cat.png' }], new Map([[9, inlinePng]]), labelerFor(assets), false))
      .toEqual({ role: 'user', content: [{ type: 'text', text: '[image asset:3f9a2c1e "cat.png"]' }, { type: 'file', mediaType: 'image/png', data: inlinePng.data }] })
  })
})
