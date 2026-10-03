import { inlineFilename } from '@/shared/file-media'
import type { ModelMessage, AssistantModelMessage, UserModelMessage, ToolModelMessage } from 'ai'
import type { SharedV4ProviderReference } from '@ai-sdk/provider'
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic'
import type { GoogleVertexImageModelOptions } from '@ai-sdk/google-vertex'
import type { OpenResponsesLanguageModelOptions } from '@ai-sdk/open-responses'
import type { OpenAICompatibleProviderOptions } from '@ai-sdk/openai-compatible'
import type { Message, InterfaceProtocol, ReasoningEffort, ConversationParams } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { FilePart, ImagePart, Part, ProviderOptions, TaskNotificationPart, ToolResultPart } from '@/shared/parts'
import { RESPONSES_PROVIDER_NAME, responsesReasoningReplayOptions } from './responses-reasoning'

export const COMPAT_PROVIDER_NAME = 'compat'

/**
 * How one attachment travels to the model: as the provider's own short-lived file pointer, or as
 * raw bytes inlined into the request (spec §5.6). Both are the AI SDK's own tagged file-data shapes.
 *
 * A file the model cannot take is its own variant with no bytes at all: nothing about it is sent
 * upstream, so nothing is fetched for it either. `gone` is a tool-delivered file whose row was
 * purged before the turn was persisted (see `toolAttachmentsMessage`).
 */
export type AttachmentInput =
  | {
    mime: string
    data:
      | { type: 'reference'; reference: SharedV4ProviderReference }
      | { type: 'data'; data: Uint8Array }
  }
  | { mime: string; unavailable: 'unreadable' | 'gone' }
  /** A text file, decoded: text travels as text, which every model reads, never as a file part. */
  | { mime: string; text: string }

/**
 * How a plugin names files to the model (spec §4.5). Without one the prompt carries the files and
 * nothing about them — no labels, no references, no pointers to tools: the core never puts tool
 * context into a conversation. Every method must be pure over what the turn has seen, so a history
 * rebuilt on the next turn reads exactly as the request that was sent.
 */
export interface FileLabeler {
  /** Text placed right before a user's attachment. */
  userFile(part: ImagePart | FilePart, mime: string): string
  /** A user's text attachment, whole or as a pointer to where it can be read. */
  userText(part: FilePart, text: string): string
  /** What stands in for an image the chat model generated, whose pixels are never replayed. */
  generatedImage(part: ImagePart): string
  /** The `asset` attribute of the wrapper around a tool-delivered file. */
  toolAttachment(attachmentId: number): string | undefined
  /** Words appended after the statement that the current model cannot read a file. */
  unreadableHint(mime: string, attachmentId: number): string
}

export interface BuildInput {
  protocol: InterfaceProtocol
  systemPrompt: string | null
  /** Root → leaf. A tool continuation ends at the assistant message that now contains its result. */
  path: Message[]
  attachments: ReadonlyMap<number, AttachmentInput>
  labeler?: FileLabeler
}

const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const

type UserPart = Extract<UserModelMessage['content'], unknown[]>[number]
type AssistantPart = Extract<AssistantModelMessage['content'], unknown[]>[number]
type ToolPart = ToolModelMessage['content'][number]

/**
 * How a background task's outcome reads to the model. Tagged plain text in a user message, the way
 * Claude Code reports its own background tasks; do not turn it into a system or developer message.
 */
export function renderTaskNotification(part: TaskNotificationPart): string {
  return [
    '<task-notification>',
    `<task-id>${part.task_id}</task-id>`,
    `<status>${part.status}</status>`,
    `<summary>${part.text}</summary>`,
    '</task-notification>',
  ].join('\n')
}

/** A tool-delivered attachment whose row no longer exists; see `toolAttachmentsMessage`. */
export const GONE: AttachmentInput = { mime: 'application/octet-stream', unavailable: 'gone' }

function inputOf(attachments: ReadonlyMap<number, AttachmentInput>, attachmentId: number): AttachmentInput {
  const att = attachments.get(attachmentId)
  if (!att) throw new Error(`attachment ${attachmentId} input not provided`)
  return att
}

/**
 * The file itself, or the sentence standing in for one the model cannot take. The name sent
 * upstream is generic (`inlineFilename`): providers show it to the model, and neither an attachment
 * id nor the person's own filename belongs there.
 */
function fileContent(att: AttachmentInput, attachmentId: number, labeler: FileLabeler | undefined): UserPart {
  if ('text' in att) return { type: 'text', text: att.text }
  if ('unavailable' in att) {
    return {
      type: 'text',
      text: att.unavailable === 'gone'
        ? 'This file no longer exists.'
        : `The current model cannot read ${att.mime}, so the file was not sent.${labeler?.unreadableHint(att.mime, attachmentId) ?? ''}`,
    }
  }
  const filename = att.mime.startsWith('image/') ? undefined : inlineFilename(att.mime)
  return { type: 'file', mediaType: att.mime, data: att.data, ...(filename ? { filename } : {}) }
}

/**
 * A text attachment with nothing else said about it: the whole file, as if pasted, under the name
 * the person gave it. No limit — a file too large for the model is the provider's error to report.
 */
export function textFile(part: FilePart, text: string, attributes = ''): string {
  const name = part.filename ? ` name="${escapeAttribute(part.filename)}"` : ''
  return `<file${attributes}${name}>\n${text}\n</file>`
}

function userParts(parts: Part[], attachments: ReadonlyMap<number, AttachmentInput>, labeler: FileLabeler | undefined): UserPart[] {
  const out: UserPart[] = []
  for (const p of parts) {
    if (p.type === 'text') {
      out.push({ type: 'text', text: p.text })
    } else if (p.type === 'image' || p.type === 'file') {
      const att = inputOf(attachments, p.attachment_id)
      if ('text' in att && p.type === 'file') {
        out.push({ type: 'text', text: labeler ? labeler.userText(p, att.text) : textFile(p, att.text) })
        continue
      }
      if (labeler) out.push({ type: 'text', text: labeler.userFile(p, att.mime) })
      out.push(fileContent(att, p.attachment_id, labeler))
    } else if (p.type === 'task_notification') {
      out.push({ type: 'text', text: renderTaskNotification(p) })
    }
    // reasoning / tool parts never appear on user messages
  }
  return out
}

/** What the AI SDK calls provider options, on a model message part or on the request itself. */
export type SdkProviderOptions = NonNullable<AssistantModelMessage['providerOptions']>

/**
 * Adds the selected metadata only when present, keeping deterministic message shapes.
 * The cast carries opaque provider JSON after any protocol-specific replay normalization.
 */
function withOptions<T extends object>(
  part: T,
  providerOptions: ProviderOptions | undefined,
): T | (T & { providerOptions: SdkProviderOptions }) {
  return providerOptions ? { ...part, providerOptions: providerOptions as SdkProviderOptions } : part
}

/** Namespaces read by the installed adapters, including their documented Gemini aliases. */
const METADATA_NAMESPACES: Record<InterfaceProtocol, readonly string[]> = {
  responses: [RESPONSES_PROVIDER_NAME],
  'chat-completions': [COMPAT_PROVIDER_NAME, 'openaiCompatible', 'google'],
  anthropic: ['anthropic'],
  'vertex-compatible': ['googleVertex', 'vertex', 'google'],
}

function targetOptions(protocol: InterfaceProtocol, stored: ProviderOptions | undefined): ProviderOptions | undefined {
  if (!stored) return undefined
  const entries = Object.entries(stored).filter(([namespace]) => METADATA_NAMESPACES[protocol]?.includes(namespace))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function assistantMessages(
  parts: Part[],
  protocol: InterfaceProtocol,
  attachments: ReadonlyMap<number, AttachmentInput>,
  labeler: FileLabeler | undefined,
): Array<AssistantModelMessage | ToolModelMessage | UserModelMessage> {
  const out: Array<AssistantModelMessage | ToolModelMessage | UserModelMessage> = []
  /**
   * Calls this message answered. A `tool_use` with no result beside it cannot be followed by a
   * user message, so left alone it would make the request itself illegal — whatever the hub meant
   * to do about it, and whether or not the hub was even running when the row was written.
   *
   * Answered here instead of dropped. Dropping is legal too, but it hides the attempt: the model
   * would not see that it had reached for something and got nothing, which is context it can act
   * on. What it gets is the call it made and an outcome that is true of every reason there might
   * be — interrupted, never dispatched, still running somewhere nobody is listening.
   *
   * Not called an error. An error is a tool that ran and failed, and none of these did: they were
   * cut short. Told the tool failed, a model concludes the tool is unreliable and stops choosing
   * it, which is the wrong lesson from a turn its own user ended.
   *
   * Written nowhere. That is what makes a late result simple: a tool that could not be aborted and
   * finishes anyway is stored as an ordinary result, the next assembly uses it instead of this,
   * and there is no race over which of the two owns the row because only one of them was ever in
   * it. The cost is a prefix cache that rebuilds from this point, which is the cheaper half of the
   * trade by a wide margin.
   */
  const answered = new Set(
    parts.filter((part): part is ToolResultPart => part.type === 'tool_result').map(part => part.call_id),
  )
  const pendingCalls = new Set<string>()
  let assistant: AssistantPart[] = []
  let tool: ToolPart[] = []
  /** Results that delivered files: they follow the tool message they belong to, see `toolAttachmentsMessage`. */
  let shown: ToolResultPart[] = []
  const flushAssistant = () => {
    if (assistant.length > 0) out.push({ role: 'assistant', content: assistant })
    assistant = []
  }
  const flushTool = () => {
    if (tool.length > 0) {
      flushAssistant()
      out.push({ role: 'tool', content: tool })
    }
    tool = []
    if (shown.length > 0) out.push(toolAttachmentsMessage(shown, attachments, labeler))
    shown = []
  }
  const appendAssistant = (part: AssistantPart) => { if (pendingCalls.size === 0) flushTool(); assistant.push(part) }
  for (const p of parts) {
    const options = targetOptions(protocol, 'providerOptions' in p ? p.providerOptions : undefined)
    switch (p.type) {
      case 'text':
        // An empty block still matters when it carries a thought signature to replay.
        if (p.text.length === 0 && !options) break
        appendAssistant(withOptions({ type: 'text', text: p.text }, options))
        break
      case 'reasoning': {
        if (p.text.length === 0 && !options) break
        const reasoningOptions = protocol === 'responses' ? responsesReasoningReplayOptions(p.text, options) : options
        // Anthropic drops unsigned thinking. Foreign reasoning remains plain historical context;
        // never manufacture a signature or attach another protocol's opaque state.
        appendAssistant(protocol === 'anthropic' && !options?.anthropic
          ? { type: 'text', text: p.text }
          : withOptions({ type: 'reasoning', text: p.text }, reasoningOptions))
        break
      }
      case 'tool_call':
        appendAssistant(withOptions({ type: 'tool-call', toolCallId: p.id, toolName: p.name, input: p.args }, options))
        if (answered.has(p.id)) pendingCalls.add(p.id)
        else {
          tool.push({
            type: 'tool-result',
            toolCallId: p.id,
            toolName: p.name,
            output: { type: 'json', value: {
              interrupted: true,
              message: '[Request interrupted by user for tool use]',
            } as never },
          })
        }
        break
      case 'tool_result':
        pendingCalls.delete(p.call_id)
        tool.push(withOptions({
          type: 'tool-result', toolCallId: p.call_id, toolName: p.name,
          output: p.is_error ? { type: 'error-text', value: String(p.content) } : { type: 'json', value: p.content as never },
        }, options))
        if (p.attachments?.length) shown.push(p)
        // Streaming tools can finish before the model has emitted its remaining calls.
        if (pendingCalls.size === 0) flushTool()
        break
      case 'image':
        // The pixels are never replayed: `requiredAttachmentIds` must skip exactly what this drops.
        // A labeler may name the image, so a tool can still open or edit it; the core says nothing.
        if (labeler) appendAssistant({ type: 'text', text: labeler.generatedImage(p) })
        break
    }
  }
  flushAssistant()
  flushTool()
  return out
}

/**
 * Which attachments `buildModelMessages` will actually ask for, given the same path. Pure, and
 * deliberately next to the builder: "which attachments does the request need?" and "which ones does
 * it use?" have to be one answer, or the caller resolves bytes for parts that are never sent.
 *
 * User uploads and files tools delivered qualify; images an assistant message holds do not, because
 * `assistantMessages` sends only their label. Resolving those too would read them out of R2 on every
 * later turn — the quadratic re-read spec §5.6 exists to remove — upload model output to the
 * provider's Files API, and fail the whole turn on a missing R2 object nothing in the request needed.
 */
export function requiredAttachmentIds(path: readonly Message[]): Set<number> {
  const ids = new Set<number>()
  for (const m of path) {
    for (const p of m.parts) {
      if (m.role === 'user' && (p.type === 'image' || p.type === 'file')) ids.add(p.attachment_id)
      if (p.type === 'tool_result') for (const id of p.attachments ?? []) ids.add(id)
    }
  }
  return ids
}

/**
 * Attachments only a tool result names. Nothing in D1 references them until the turn is persisted,
 * so a purge in between can remove their row; message parts keep theirs referenced.
 */
export function toolDeliveredAttachmentIds(path: readonly Message[]): Set<number> {
  const named = new Set<number>()
  const delivered = new Set<number>()
  for (const m of path) {
    for (const p of m.parts) {
      if (p.type === 'image' || p.type === 'file') named.add(p.attachment_id)
      if (p.type === 'task_notification') for (const id of p.attachments ?? []) named.add(id)
      if (p.type === 'tool_result') for (const id of p.attachments ?? []) delivered.add(id)
    }
  }
  return new Set([...delivered].filter(id => !named.has(id)))
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Files tools delivered, as the one user message that follows a batch of tool results (spec §7.2).
 * A user message because every protocol accepts files there, while tool results carry them on only
 * some, and only as base-64 resent on every later turn. Built identically mid-turn (`prepareStep`)
 * and when the history is rebuilt, so the prompt prefix stays byte-identical.
 */
export function toolAttachmentsMessage(
  results: readonly ToolResultPart[],
  attachments: ReadonlyMap<number, AttachmentInput>,
  labeler: FileLabeler | undefined,
): UserModelMessage {
  const content = results.flatMap(result => (result.attachments ?? []).flatMap((attachmentId): UserPart[] => {
    // A tool can deliver a workspace file whose bytes are purged before the turn is persisted, when
    // nothing in D1 references it yet: its input is then `gone`, and says so instead of throwing,
    // since a throw here would fail every later turn and nothing brings the bytes back.
    const att = inputOf(attachments, attachmentId)
    const asset = 'unavailable' in att && att.unavailable === 'gone' ? undefined : labeler?.toolAttachment(attachmentId)
    return [
      { type: 'text', text: `<tool_attachment call_id="${escapeAttribute(result.call_id)}"${asset === undefined ? '' : ` asset="${escapeAttribute(asset)}"`}>` },
      fileContent(att, attachmentId, labeler),
      { type: 'text', text: '</tool_attachment>' },
    ]
  }))
  return { role: 'user', content }
}

/**
 * Stored on the half-turn a handoff closed. Everything it produced is intact, so it is `done` and
 * the UI shows nothing — only `status === 'error'` renders this column — but the prompt builder
 * needs to know the reply was taken over rather than finished.
 *
 * Do not try to infer this from the shape of the parts. A reply ending on a `tool_result` looks
 * identical and is perfectly ordinary: `awaitsHumanToolResult` stops a turn exactly there, so every
 * ask_user leaves one, and telling the model those were interrupted makes it apologise for a
 * conversation that never happened.
 */
export const INTERJECTED = 'interjected'

/**
 * What an interruption looks like from the model's side.
 *
 * Verbatim from Claude Code's `INTERRUPT_MESSAGE`, and placed where it places it: text in a user
 * message, at the point the turn stopped. Plain text because that is what every provider accepts;
 * a `developer` or `system` block mid-conversation is not.
 *
 * Do not translate it and do not explain it. A longer version here spelled out that the reply above
 * was cut off and which parts still counted; models called it awkward and asked what it meant. Its
 * whole value is being a string they have seen a great deal of.
 *
 * One line covers every ending, because they are the same event:
 *
 * - Stopped with work already done. That work stays; rolling back would contradict the screen.
 * - Stopped before the turn produced anything. Then it is not a turn, and the user messages either
 *   side of it become one — Anthropic requires the roles to alternate.
 * - Taken over the moment the operator spoke. Stored as `done`, and marked with `INTERJECTED`.
 */
const INTERRUPT_MESSAGE = '[Request interrupted by user]'

/**
 * The message a handoff has to splice into a run that is already in flight.
 *
 * Nothing rebuilds the prompt from the database mid-run: the SDK carries its own message list from
 * step to step, so words stored by a handoff are words the model never sees unless they are handed
 * to `prepareStep` as an override. Built here, next to the rule it mirrors, so the request sent now
 * and the one rebuilt from the rows on the next turn say the same thing — note first, then what
 * they said, exactly where `buildModelMessages` puts it for a reply that ends on a tool result.
 *
 * `interrupted` is false when only task notifications arrived: nobody cut the reply short, it is
 * stored without `INTERJECTED`, and the rebuilt prompt carries no note — so neither may this one.
 */
export function interjectedUserMessage(
  said: Part[],
  attachments: ReadonlyMap<number, AttachmentInput>,
  labeler: FileLabeler | undefined,
  interrupted: boolean,
): ModelMessage {
  const content = userParts(said, attachments, labeler)
  return { role: 'user', content: interrupted ? [{ type: 'text', text: INTERRUPT_MESSAGE }, ...content] : content }
}

/**
 * Pure. Same input → byte-identical output, whether the parts came from memory or from D1.
 * Nothing request-specific may ever be added here (see spec §7.2).
 *
 * Callers must pass `allowSystemInMessages: true` to streamText; the system prompt is emitted as a
 * system message so Anthropic cache breakpoints can attach to it. The option defaults to false,
 * which rejects a `role: 'system'` message inside `messages`.
 */
export function buildModelMessages(input: BuildInput): ModelMessage[] {
  const { protocol, systemPrompt, path, attachments, labeler } = input
  const out: ModelMessage[] = []
  const cache = protocol === 'anthropic'

  if (systemPrompt !== null && systemPrompt.length > 0) {
    out.push(cache
      ? { role: 'system', content: systemPrompt, providerOptions: ANTHROPIC_CACHE }
      : { role: 'system', content: systemPrompt })
  }

  const lastUserIndex = path.map((m) => m.role).lastIndexOf('user')
  /** Carried onto the next user message: a note about the turn that came before it. */
  let pending: string | null = null
  /** Set when the turn in between said nothing, so the user messages around it are one message. */
  let joinToPrevious = false

  path.forEach((m, i) => {
    if (m.role === 'user') {
      const said = userParts(m.parts, attachments, labeler)
      // A plugin's notes, stored on the message: replayed as they were sent, whatever is on now.
      const reminder = (text: string): UserPart => ({ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` })
      const lead = (m.notes ?? []).filter(note => note.at === 'start').map(note => reminder(note.text))
      const tail = (m.notes ?? []).filter(note => note.at !== 'start').map(note => reminder(note.text))
      const content: UserPart[] = pending === null ? [...lead, ...said, ...tail] : [...lead, { type: 'text', text: pending }, ...said, ...tail]
      pending = null

      const previous = joinToPrevious ? out.at(-1) : undefined
      joinToPrevious = false
      if (previous && previous.role === 'user' && Array.isArray(previous.content)) {
        previous.content = [...previous.content, ...content]
        if (cache && i === lastUserIndex) previous.providerOptions = ANTHROPIC_CACHE
        return
      }

      out.push(cache && i === lastUserIndex
        ? { role: 'user', content, providerOptions: ANTHROPIC_CACHE }
        : { role: 'user', content })
      return
    }

    const said = assistantMessages(m.parts, protocol, attachments, labeler)
    if (said.length === 0) {
      // A turn that said nothing, however it ended — stopped by hand, or handed off the moment the
      // operator spoke. There is no turn here to put between two user messages, and leaving a gap
      // would break the alternation Anthropic insists on. Judged by what it produced rather than by
      // its status, because a handoff finalises a silent turn as `done` and an abort does not.
      pending = INTERRUPT_MESSAGE
      joinToPrevious = true
      return
    }
    out.push(...said)
    // A note belongs to the message right after the turn it describes. Set it or clear it here:
    // a reply standing between the interruption and the next thing said means the turn was
    // answered after all, and carrying the note past it marks an innocent message as interrupted.
    pending = m.status === 'aborted' || m.error === INTERJECTED ? INTERRUPT_MESSAGE : null
  })

  return out
}

const ANTHROPIC_THINKING = { type: 'adaptive', display: 'summarized' } as const

/**
 * Whether a picture placed *inside a tool result* still reaches the model on this protocol.
 *
 * Narrower than "the model reads images", and answered here rather than by the catalog, because
 * what breaks is the wire format.
 *
 * `chat-completions` is the one that cannot: OpenAI's own schema allows only `text` parts in a
 * tool message (`ChatCompletionRequestToolMessageContentPart`), and `@ai-sdk/openai-compatible`
 * serializes the whole content output with `JSON.stringify` — a 117KB screenshot leaves as 1.33MB
 * of `{"0":255,"1":216,...}`, measured, and the model still sees no picture. Some vendors do
 * extend that message (DeepSeek accepts `image_url` and `file_id` there), but nothing in the spec
 * makes that portable, and the adapter destroys the bytes before any of them are asked.
 *
 * The other three emit real image parts: Anthropic an `image` block, Responses an `input_image`,
 * Google `inlineData` inside `functionResponse` on both its current and legacy branches.
 */
export function carriesToolResultImages(protocol: InterfaceProtocol): boolean {
  switch (protocol) {
    case 'anthropic':
    case 'responses':
    case 'vertex-compatible':
      return true
    case 'chat-completions':
      return false
  }
}

/**
 * Gemini's `thinkingConfig`, reached through the only google-vertex export that carries it:
 * `GoogleVertexImageModelOptions` is declared as `Omit<GoogleLanguageModelOptions,
 * 'responseModalities'>` (@ai-sdk/google-vertex@5.0.75 dist/index.d.ts:37), and `@ai-sdk/google` is
 * not a direct dependency of this repo.
 */
type GeminiThinkingOptions = Pick<GoogleVertexImageModelOptions, 'thinkingConfig'>
type GeminiThinkingLevel = NonNullable<NonNullable<GeminiThinkingOptions['thinkingConfig']>['thinkingLevel']>
type AnthropicEffort = NonNullable<AnthropicProviderOptions['effort']>

/**
 * The reasoning levels each protocol actually accepts, taken from the installed SDK's own enums so
 * the compiler — not a comment — is what keeps these lists honest. Our `ReasoningEffort` is wider
 * than both: Anthropic rejects `minimal` and `ultra`, Gemini rejects `xhigh`, `max` and `ultra`.
 */
const ANTHROPIC_EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const GEMINI_THINKING_LEVELS: readonly GeminiThinkingLevel[] = ['minimal', 'low', 'medium', 'high']

/**
 * Gemini's image output modality. This is the one option literal here the installed SDK's types
 * cannot check: `GoogleVertexImageModelOptions` is `Omit<GoogleLanguageModelOptions,
 * 'responseModalities'>` (@ai-sdk/google-vertex@5.0.75 dist/index.d.ts:37), and `@ai-sdk/google` —
 * which declares it as `("TEXT" | "IMAGE")[]` (@ai-sdk/google@4.0.63 dist/index.d.ts:19) — is not a
 * direct dependency of this repo.
 */
const GEMINI_IMAGE_MODALITIES = { responseModalities: ['TEXT', 'IMAGE'] }

/** A level the protocol cannot express is simply not sent; the request stays a reasoning request. */
function accept<T extends ReasoningEffort>(levels: readonly T[], effort: ReasoningEffort | undefined): T | undefined {
  return levels.find((level) => level === effort)
}

/**
 * Reasoning settings affect only this request. Resolved catalog metadata declares model support;
 * neither these options nor the current capability can remove stored reasoning from history.
 */
export function buildProviderOptions(
  protocol: InterfaceProtocol,
  params: ConversationParams | null,
  metadata: ModelMetadata,
): SdkProviderOptions {
  const enabled = metadata.reasoning === true && params?.reasoning_enabled !== false
  const requested = enabled ? (params?.reasoning_effort ?? undefined) : undefined
  const options = metadata.reasoning_options ?? []
  const declared = options.flatMap(option => option.type === 'effort' ? option.values ?? [] : [])
  // A model only receives a level it declares. No declaration at all means "undeclared", not
  // "nothing allowed", so an effort survives models that never listed their levels (spec §4.4).
  const effort = requested === undefined || declared.length === 0 || declared.includes(requested) ? requested : undefined
  const disable = metadata.reasoning === true && params?.reasoning_enabled === false
    && (options.some(option => option.type === 'toggle') || declared.includes('none'))
  switch (protocol) {
    case 'responses': {
      const value = disable ? 'none' : effort
      return value ? { [RESPONSES_PROVIDER_NAME]: { reasoningEffort: value } satisfies OpenResponsesLanguageModelOptions } : {}
    }
    case 'chat-completions': {
      const value = disable ? 'none' : effort
      return value ? { [COMPAT_PROVIDER_NAME]: { reasoningEffort: value } satisfies OpenAICompatibleProviderOptions } : {}
    }
    case 'anthropic': {
      if (!enabled) return disable ? { anthropic: { thinking: { type: 'disabled' } } satisfies AnthropicProviderOptions } : {}
      const accepted = accept(ANTHROPIC_EFFORTS, effort)
      return { anthropic: {
        thinking: ANTHROPIC_THINKING,
        ...(accepted ? { effort: accepted } : {}),
      } satisfies AnthropicProviderOptions }
    }
    case 'vertex-compatible': {
      // Image output is asked for only from a model that declares the capability (spec §4.4/§5.8);
      // it is never inferred from a model id, and it is independent of the reasoning settings.
      const hasImageOutput = metadata.modalities?.output.includes('image') === true
      const image = hasImageOutput ? GEMINI_IMAGE_MODALITIES : {}
      if (!enabled) {
        if (!disable) return hasImageOutput ? { googleVertex: { ...image } } : {}
        const off = { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } satisfies GeminiThinkingOptions
        return { googleVertex: { ...image, ...off } }
      }
      const level = accept(GEMINI_THINKING_LEVELS, effort)
      const thinking = {
        thinkingConfig: { includeThoughts: true, ...(level ? { thinkingLevel: level } : {}) },
      } satisfies GeminiThinkingOptions
      return { googleVertex: { ...image, ...thinking } }
    }
    // Protocols outside the built-ins (e.g. one registered by a test) get no provider options.
    default:
      return {}
  }
}
