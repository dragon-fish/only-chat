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
    // A reply that ran to its own finish ends on text. Do not drop this: ending on a `tool_result`
    // is the mark of a turn that was taken over, and the fixture would then be that instead.
    { type: 'text', text: 'yes, a cat' },
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

  it('tells the model a reply ending on a tool result was taken over, not finished', () => {
    // A handoff keeps everything the half-turn produced, so it is stored as `done` — the status
    // says nothing. Without this, the model reads its own unanswered lookup as a turn it chose to
    // end, and the operator's words as a fresh topic rather than an interruption.
    const out = build([
      msg({ id: 1, role: 'user', parts: [{ type: 'text', text: '搜一下' }] }),
      msg({ id: 2, role: 'assistant', status: 'done', parts: [
        { type: 'tool_call', id: 'c', name: 'lookup', args: {} },
        { type: 'tool_result', call_id: 'c', name: 'lookup', content: { ok: true } },
      ] }),
      msg({ id: 3, role: 'user', parts: [{ type: 'text', text: '算了' }] }),
    ])
    const last = out.at(-1) as { role: string, content: Array<{ text: string }> }
    expect(last.role).toBe('user')
    expect(last.content[0]!.text).toContain('没有说完')
    expect(last.content.at(-1)!.text).toBe('算了')
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
    const said = (out[2] as { content: Array<{ text: string }> }).content.map(c => c.text)
    expect(said).toEqual([
      expect.stringContaining('没有说完'), '乙',
      expect.stringContaining('中间没有模型的回复'), '丙',
      expect.stringContaining('中间没有模型的回复'), '丁',
    ])
  })
})
