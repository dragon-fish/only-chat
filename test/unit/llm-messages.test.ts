import { describe, expect, it } from 'vitest'
import { buildModelMessages, buildProviderOptions, requiredAttachmentIds, type AttachmentInput, type BuildInput } from '@/server/plugins/llm/messages'
import type { Message } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { InterfaceProtocol } from '@/shared/models'

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
  ] }),
  msg({ id: 3, role: 'user', parts: [{ type: 'text', text: 'and now?' }] }),
]

function input(protocol: InterfaceProtocol): BuildInput {
  return { protocol, systemPrompt: 'be brief', path, attachments: new Map([[9, inlinePng]]) }
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
    expect(user.content[1]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } })
  })

  it('sends a provider file pointer as a reference part instead of bytes', () => {
    const reference = { openai: 'file-abc123' }
    const out = buildModelMessages({
      ...input('responses'),
      attachments: new Map([[9, { mime: 'image/png', data: { type: 'reference', reference } }]]),
    })
    const user = out[1] as { content: Array<{ type: string; mediaType?: string; data?: unknown }> }
    expect(user.content[1]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'reference', reference } })
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

describe('interjections', () => {
  const interrupted: Message[] = [
    msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'start' }] }),
    msg({ id: 2, role: 'assistant', parts: [
      { type: 'text', text: 'working on it' },
      { type: 'tool_call', id: 'c1', name: 'lookup', args: {} },
      { type: 'tool_result', call_id: 'c1', name: 'lookup', content: { ok: true } },
      { type: 'interjection', parts: [{ type: 'text', text: 'actually, in French' }, { type: 'image', attachment_id: 7 }] },
      { type: 'text', text: 'voilà' },
    ] }),
  ]

  it('replays it as a user message between the steps it arrived between', () => {
    const out = buildModelMessages({
      protocol: 'chat-completions', systemPrompt: null, path: interrupted,
      attachments: new Map([[7, inlinePng]]),
    })
    // The model met it after the tool answered and before the next step; so does the replay.
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
    const said = out[3] as { content: Array<{ type: string, text?: string }> }
    // A note first, then what was actually said. The SDK calls an inlined image a file part.
    expect(said.content.map(part => part.type)).toEqual(['text', 'text', 'file'])
    expect(said.content[1]?.text).toBe('actually, in French')
  })

  it('tells the model it was interrupted, rather than handing it a bare message', () => {
    // Unexplained, a user message appearing mid-work reads as a new turn, and the model answers it
    // from the top instead of folding it into what it was already doing.
    const out = buildModelMessages({
      protocol: 'chat-completions', systemPrompt: null, path: interrupted,
      attachments: new Map([[7, inlinePng]]),
    })
    const note = (out[3] as { content: Array<{ text?: string }> }).content[0]?.text ?? ''
    expect(note).toContain('这一轮工作进行期间')
    expect(note).toContain('不是新的一轮提问')
  })

  it('resolves the images it carries, wherever the message says they live', () => {
    // requiredAttachmentIds and the builder have to agree, or bytes are fetched for parts that are
    // never sent — or worse, a part is sent with nothing to send.
    expect(requiredAttachmentIds(interrupted)).toEqual(new Set([7]))
  })
})

describe('interrupted turns', () => {
  const build = (path: Message[]) => buildModelMessages({
    protocol: 'chat-completions', systemPrompt: null, path, attachments: new Map(),
  })

  it('keeps what an interrupted turn managed to do, and says it was interrupted', () => {
    // The screen still shows the reply stopping partway. Rolling back to before it would
    // contradict that, and throw away work the model had already done.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '查一下' }] }),
      msg({ id: 2, role: 'assistant', status: 'aborted', parts: [
        { type: 'tool_call', id: 'c1', name: 'lookup', args: {} },
        { type: 'tool_result', call_id: 'c1', name: 'lookup', content: { ok: true } },
        { type: 'text', text: '我查到了一半' },
      ] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '算了，换个方向' }] }),
    ])
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    const said = out.at(-1) as { content: Array<{ text?: string }> }
    expect(said.content[0]?.text).toContain('主动打断')
    expect(said.content[1]?.text).toBe('算了，换个方向')
  })

  it('joins the two user messages when the turn between them said nothing', () => {
    // Anthropic requires the roles to alternate, so a silent turn between two user messages is an
    // error rather than an oddity.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '第一句' }] }),
      msg({ id: 2, role: 'assistant', status: 'aborted', parts: [] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '第二句' }] }),
    ])
    expect(out.map(m => m.role)).toEqual(['user'])
    const said = out[0] as { content: Array<{ text?: string }> }
    expect(said.content.map(part => part.text)).toEqual(['第一句', expect.stringContaining('打断'), '第二句'])
  })

  it('says nothing extra about a turn that ended on its own', () => {
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '问' }] }),
      msg({ id: 2, role: 'assistant', parts: [{ type: 'text', text: '答' }] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '再问' }] }),
    ])
    const said = out.at(-1) as { content: Array<{ text?: string }> }
    expect(said.content).toHaveLength(1)
    expect(said.content[0]?.text).toBe('再问')
  })
})

describe('rolling back to somewhere legal', () => {
  const build = (path: Message[]) => buildModelMessages({
    protocol: 'chat-completions', systemPrompt: null, path, attachments: new Map(),
  })

  it('drops a call nothing ever answered, wherever it came from', () => {
    // A tool_use with no result beside it cannot be followed by a user message, so replaying one
    // makes the request itself illegal. Assembling the prompt is the last place that can decide
    // what is legal, and it would rather lose a step than be unable to speak at all.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '查' }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'text', text: '这就去' },
        { type: 'tool_call', id: 'never', name: 'lookup', args: {} },
      ] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '算了' }] }),
    ])
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    const said = out[1] as { content: Array<{ type: string }> }
    expect(said.content.map(part => part.type)).toEqual(['text'])
  })

  it('keeps the call that was answered and drops only the one that was not', () => {
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '查两个' }] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'tool_call', id: 'ok', name: 'lookup', args: {} },
        { type: 'tool_call', id: 'never', name: 'lookup', args: {} },
        { type: 'tool_result', call_id: 'ok', name: 'lookup', content: { ok: true } },
      ] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '够了' }] }),
    ])
    const calls = (out[1] as { content: Array<{ type: string, toolCallId?: string }> }).content
    expect(calls).toMatchObject([{ type: 'tool-call', toolCallId: 'ok' }])
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
  })

  it('leaves nothing between two user messages when the whole turn was unusable', () => {
    // Nothing the hub does or fails to do can produce an illegal prompt from here.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '第一句' }] }),
      msg({ id: 2, role: 'assistant', status: 'aborted', parts: [
        { type: 'tool_call', id: 'never', name: 'lookup', args: {} },
      ] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '第二句' }] }),
    ])
    expect(out.map(m => m.role)).toEqual(['user'])
  })
})
