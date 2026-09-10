import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { api } from '@/client/lib/api'
import { WsClient, type WsStatus } from '@/client/lib/ws-client'
import type { ModelRef } from '@/shared/api'
import type { Message, Project, Conversation, ConversationParams, UserSettings } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { Part, ToolResultPart } from '@/shared/parts'
import type { EditCommand, RegenerateCommand, SendCommand, WsCommand, WsEvent } from '@/shared/ws'

/**
 * The reasoning slider's stops, weakest first (spec §3.3). `off` and `auto` are states rather than
 * strengths: `off` turns reasoning off explicitly, `auto` turns it on without sending an effort.
 */
export const REASONING_ORDER = ['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningStop = (typeof REASONING_ORDER)[number]
/** `inherit` is not a stop: it writes nothing at all, leaving the field to the layer below. */
export type ReasoningChoice = 'inherit' | ReasoningStop

export const REASONING_LABELS: Record<ReasoningStop, string> = {
  off: '立即', auto: '自动', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: 'Max', ultra: 'Ultra',
}

/** Catalog reasoning options are the only declarations of disable support and effort levels. */
export function reasoningStopsFor(metadata: ModelMetadata | undefined): ReasoningStop[] {
  if (metadata?.reasoning !== true) return []
  const options = metadata.reasoning_options ?? []
  const declared = options.flatMap(option => option.type === 'effort' ? option.values ?? [] : [])
  const canDisable = options.some(option => option.type === 'toggle') || declared.includes('none')
  return REASONING_ORDER.filter((stop) => {
    if (stop === 'off') return canDisable
    if (stop === 'auto') return true
    return declared.includes(stop)
  })
}

/** What the three reasoning widgets show, derived from one stop list (spec §5.5). */
export interface ReasoningControlModel {
  /** Whether the 思考 switch can be turned off at all. */
  canDisable: boolean
  /**
   * Whether reasoning is currently on. Forced `true` when the axis cannot express `off`: the
   * switch is then disabled *and locked on*, never disabled at a stored `off` (spec §5.5).
   */
  enabled: boolean
  /** On means "enabled, with no strength pinned" — the provider decides. */
  auto: boolean
  /** The slider's axis. Never contains `off` or `auto`: neither is a strength. */
  strengths: ReasoningStop[]
  /** Index into `strengths`; -1 whenever no strength is pinned. */
  index: number
  /** A stored strength this model does not offer. Shown as-is, never silently rewritten. */
  unsupported: boolean
}

export type ReasoningAction =
  | { kind: 'enable'; on: boolean }
  | { kind: 'auto'; on: boolean }
  | { kind: 'strength'; stop: ReasoningStop }

/**
 * `active` is the value in force at this layer — the layer's own choice, or what it inherits.
 * `inherit` reaching here means nothing is pinned anywhere, which is the same request as `auto`:
 * reason, but send no effort.
 */
export function reasoningControlModel(stops: ReasoningStop[], active: ReasoningChoice): ReasoningControlModel {
  const strengths = stops.filter((s): s is ReasoningStop => s !== 'off' && s !== 'auto')
  const canDisable = stops.includes('off')
  // A stored off choice must not disable all controls when this model cannot turn reasoning off.
  const lockedOn = active === 'off' && !canDisable
  const enabled = active !== 'off' || lockedOn
  // A locked-on `off` pins no strength, which is the same thing 自动 means: reason, send no effort.
  const auto = enabled && (active === 'auto' || active === 'inherit' || lockedOn)
  // Narrowed by literal comparison, not by the `auto`/`enabled` booleans above, so the compiler
  // can see `active` is a real stop here without a cast: only `off`/`auto`/`inherit` are excluded.
  const index = active === 'off' || active === 'auto' || active === 'inherit' ? -1 : strengths.indexOf(active)
  return {
    canDisable,
    enabled,
    auto,
    strengths,
    index,
    unsupported: enabled && !auto && index < 0,
  }
}

/**
 * Spec §5.1/§6: a reasoning control that cannot act states why instead of rendering dead widgets.
 * Shared by both hosts — the Composer's chip, which disables itself and shows this as its `title`,
 * and the inline body, which renders it in place of the three controls — so the two cannot drift.
 *
 * A model that cannot reason yields NO stops at all. Do NOT derive this from
 * `ReasoningControlModel.unsupported`: that flag means "a strength is stored that this model does
 * not offer", and it is false for a non-reasoning model, so it would leave the control enabled on
 * exactly the model it must disable for. The chip's own extra case — no model resolved yet — is
 * not expressible from stops and stays with the chip.
 */
/**
 * What the chip reads. Pure because it is the only user-visible output that the locked-on rule
 * changes (a stored `off` on a model that cannot disable now reads 自动, not 立即), and a component
 * cannot be tested in this repo.
 *
 * Spec §5.5: a stored strength this model does not offer is shown AS-IS, never rewritten — which is
 * why this reads `active` rather than indexing `strengths`, where `index` would be -1 and any
 * fallback would name a stop the user never chose.
 */
export function reasoningChipLabel(model: ReasoningControlModel, active: ReasoningChoice): string {
  if (!model.enabled) return REASONING_LABELS.off
  if (model.auto || active === 'inherit') return REASONING_LABELS.auto
  return REASONING_LABELS[active]
}

export function reasoningDisabledReason(stops: ReasoningStop[]): string | null {
  return stops.length === 0 ? '该模型不支持推理' : null
}

/**
 * The choice each widget interaction writes. Leaving 自动 lands on the middle strength: the spec
 * defines entering auto and picking a stop, but not leaving auto by the toggle, and the midpoint
 * is the one answer that does not bias the user toward either end of the axis.
 */
export function reasoningChoiceFor(model: ReasoningControlModel, action: ReasoningAction): ReasoningChoice {
  if (action.kind === 'strength') return action.stop
  if (action.kind === 'enable') return action.on ? 'auto' : 'off'
  if (action.on) return 'auto'
  const middle = model.strengths[Math.floor((model.strengths.length - 1) / 2)]
  return middle ?? 'auto'
}

/** The merged control writes the two independently stored keys (spec §3.3). */
export function choiceToParams(choice: ReasoningChoice): ConversationParams {
  if (choice === 'inherit') return {}
  if (choice === 'off') return { reasoning_enabled: false }
  return { reasoning_enabled: true, reasoning_effort: choice === 'auto' ? null : choice }
}

/**
 * The inverse. Presence decides, never truthiness: a `null` `reasoning_effort` is explicit Auto and
 * must not collapse into `inherit`, which is what an `??` default would silently do.
 *
 * Lossy in one direction only: the two keys inherit independently in storage, but the merged
 * control has one position, so a half-set pair (an effort with no `reasoning_enabled`) reads as
 * that effort and is written back as a full pair. Nothing in this UI can produce a half-set pair —
 * `choiceToParams` always writes both keys — so the round trip is stable for anything it stores.
 */
export function choiceFromParams(params: ConversationParams | null | undefined): ReasoningChoice {
  if (!params) return 'inherit'
  if (params.reasoning_enabled === false) return 'off'
  if (params.reasoning_enabled === undefined && params.reasoning_effort === undefined) return 'inherit'
  return params.reasoning_effort ?? 'auto'
}

/**
 * The generation parameters a Project and a conversation edit the same way. Typed `string | number`,
 * not `string`: the three numeric fields are edited by `NumberField`, which is `number | undefined`
 * valued, so a filled box writes a real `number` here while blank stays `''` — the sentinel that
 * makes `paramsFromFields` drop the key instead of writing a value the layer never chose. Two
 * shapes, one field, and a `string`-only type would describe neither of them.
 *
 * (The union predates `NumberField`. It was introduced for the raw `<input type="number">` inside
 * `Input`, whose DOM `v-model` cast the value unconditionally; Task 6 deleted that path, but the
 * union is still exactly right for the reason above, so do not narrow it back to `string`.)
 */
export interface ParamFields {
  temperature: string | number
  top_p: string | number
  max_tokens: string | number
  reasoning: ReasoningChoice
}

/**
 * Blank stays blank: an unparseable or empty box contributes no key at all. Accepts a number
 * because a `ParamFields` slot holds either shape (see there) and a `.trim()` on the number branch
 * would throw.
 *
 * Exported because the settings forms read the field back through it on every render: `NumberField`
 * is `number | undefined` valued, so this converts the slot into exactly what the box should show —
 * and `undefined`, not `0`, is what keeps a blank box blank. The forms also test it for blankness,
 * which is what gates their steppers: blank means "inherit", and no stepper may fill it in.
 */
export function optionalNumber(raw: string | number): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

function numberToField(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/**
 * Whether the box the user is looking at is empty, which is what decides if a stepper may fire.
 *
 * `raw` is the input element's live text, or `null` when the field is not being edited. The form
 * model cannot answer this on its own: reka writes typed text back only on blur or Enter
 * (`NumberFieldInput` binds `applyInputValue` to those two), so from the moment a filled box is
 * cleared until it loses focus, the model still holds the old value while the box reads empty.
 * Asking the model there is what let a stepper press on a visibly empty 最大 tokens commit `min`.
 */
export function fieldLooksBlank(raw: string | null, stored: string | number): boolean {
  // Not `raw.trim() === ''`: reka gates the steppers on whether its parse yields NaN, not on
  // whether the box has characters, and it accepts partial input on the way to a number. A lone
  // `.` is the cheapest example — one keystroke, accepted, and unparseable — so treating it as
  // filled re-opened the very defect this guard exists to close.
  if (raw !== null) {
    const text = raw.trim()
    return text === '' || !Number.isFinite(Number(text))
  }
  return optionalNumber(stored) === undefined
}

/** `null` when the user filled nothing in, so the `params` column stays NULL. */
export function paramsFromFields(fields: ParamFields): ConversationParams | null {
  const temperature = optionalNumber(fields.temperature)
  const top_p = optionalNumber(fields.top_p)
  const max_tokens = optionalNumber(fields.max_tokens)
  const params: ConversationParams = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(top_p === undefined ? {} : { top_p }),
    ...(max_tokens === undefined ? {} : { max_tokens }),
    ...choiceToParams(fields.reasoning),
  }
  return Object.keys(params).length === 0 ? null : params
}

/** Absent values render as blank fields, never as the inherited value they would resolve to. */
export function fieldsFromParams(params: ConversationParams | null | undefined): ParamFields {
  return {
    temperature: numberToField(params?.temperature),
    top_p: numberToField(params?.top_p),
    max_tokens: numberToField(params?.max_tokens),
    reasoning: choiceFromParams(params),
  }
}

/** What the Project settings form holds. Only `name` is required (spec §3.1); every other field
 *  may be blank, and blank must travel as `null`/absent rather than as a copied inherited value. */
export interface ProjectFormState extends ParamFields {
  name: string
  icon_attachment_id: number | null
  system_prompt: string
  model: ModelRef | null
}

export function projectParamsFromForm(form: ProjectFormState): ConversationParams | null {
  return paramsFromFields(form)
}

/**
 * The inverse of `projectUpdateCommand`: what the settings form shows for a stored Project.
 * Absent values render as blank fields, never as the inherited value they would resolve to.
 * `undefined` yields the blank form, so switching Projects resets through one canonical shape
 * instead of a hand-written list of fields that can drift as the form grows.
 */
export function projectFormFrom(project: Project | undefined): ProjectFormState {
  return {
    name: project?.name ?? '',
    icon_attachment_id: project?.icon_attachment_id ?? null,
    system_prompt: project?.system_prompt ?? '',
    model: project && project.provider_id !== null && project.model_id !== null
      ? { provider_id: project.provider_id, model_id: project.model_id }
      : null,
    ...fieldsFromParams(project?.params),
  }
}

/** The prompt is stored verbatim — trimming is only used to decide whether it is empty (spec §3.2). */
export function projectUpdateCommand(projectId: number, form: ProjectFormState): WsCommand {
  return {
    type: 'project.update',
    project_id: projectId,
    name: form.name.trim(),
    icon_attachment_id: form.icon_attachment_id,
    system_prompt: blankToNull(form.system_prompt),
    provider_id: form.model?.provider_id ?? null,
    model_id: form.model?.model_id ?? null,
    params: projectParamsFromForm(form),
  }
}

/** Stored verbatim; the trim only decides whether the user left the box empty. */
function blankToNull(value: string): string | null {
  return value.trim() === '' ? null : value
}

/** What the Composer's settings popover holds for the open conversation, or for an unsent draft. */
export interface ConversationSettingsForm extends ParamFields {
  title: string
  system_prompt: string
}

/** Only the conversation's own overrides: an inherited value shown here would be copied down on save. */
export function conversationFormFrom(conversation: Conversation | undefined): ConversationSettingsForm {
  return {
    title: conversation?.title ?? '',
    system_prompt: conversation?.system_prompt ?? '',
    ...fieldsFromParams(conversation?.params),
  }
}

/** The conversation-level fields inheritance reads; an unsent draft satisfies it as well as a `Conversation`. */
export type ConversationConfigSource = Pick<Conversation, 'system_prompt' | 'provider_id' | 'model_id' | 'params'>

/** Which layer a field's current value comes from, for its 继承自 Project / 会话覆盖 badge (spec §7.3). */
export type SettingSource = 'conversation' | 'project' | 'default'

export interface ConversationSettingSources {
  system_prompt: SettingSource
  model: SettingSource
  temperature: SettingSource
  top_p: SettingSource
  max_tokens: SettingSource
  reasoning: SettingSource
}

function sourceOf(inConversation: boolean, inProject: boolean): SettingSource {
  return inConversation ? 'conversation' : inProject ? 'project' : 'default'
}

/**
 * Presence decides every field: `temperature: 0` and an explicit-Auto `reasoning_effort: null` are
 * real conversation overrides. Reasoning reports one source for the merged control even though the two
 * keys inherit independently — either key present in a layer makes that layer the source.
 */
export function conversationSettingSources(conversation: ConversationConfigSource, project: Project | undefined): ConversationSettingSources {
  const own = conversation.params
  const inherited = project?.params
  const param = (key: 'temperature' | 'top_p' | 'max_tokens'): SettingSource =>
    sourceOf(own?.[key] !== undefined, inherited?.[key] !== undefined)
  const hasReasoning = (p: ConversationParams | null | undefined) =>
    p?.reasoning_enabled !== undefined || p?.reasoning_effort !== undefined
  return {
    system_prompt: sourceOf(conversation.system_prompt !== null, (project?.system_prompt ?? null) !== null),
    model: sourceOf(
      conversation.provider_id !== null && conversation.model_id !== null,
      project?.provider_id != null && project.model_id != null,
    ),
    temperature: param('temperature'),
    top_p: param('top_p'),
    max_tokens: param('max_tokens'),
    reasoning: sourceOf(hasReasoning(own), hasReasoning(inherited)),
  }
}

/** Which layer supplies the model the next generation will use (spec §5.3). */
export type ModelSource = 'conversation' | 'project' | 'command'

export interface EffectiveModel {
  model: ModelRef | null
  /** `null` only when no layer supplies a model at all. */
  source: ModelSource | null
}

export interface ExistingChatModelContext {
  /** `undefined` means this page has not made a deliberate model choice for the conversation. */
  localPick: ModelRef | null | undefined
  messagesLoaded: boolean
  /** The selected message branch, oldest first. */
  messages: readonly Message[]
}

function lastGenerationModel(messages: readonly Message[]): ModelRef | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.provider_id !== null && message.model_id !== null) {
      return { provider_id: message.provider_id, model_id: message.model_id }
    }
  }
  return null
}

/**
 * The client's mirror of the server's precedence: conversation override → Project default → the model
 * this command carries. The Composer shows the result, so it never claims a model the generation
 * would not actually use.
 */
export function effectiveModelFor(
  override: ModelRef | null,
  project: Project | undefined,
  picked: ModelRef | null,
  chat?: ExistingChatModelContext,
): EffectiveModel {
  if (override) return { model: override, source: 'conversation' }
  if (project?.provider_id != null && project.model_id != null) {
    return { model: { provider_id: project.provider_id, model_id: project.model_id }, source: 'project' }
  }
  const command = chat
    ? chat.localPick !== undefined
      ? chat.localPick
      : lastGenerationModel(chat.messages) ?? (chat.messagesLoaded ? picked : null)
    : picked
  return command ? { model: command, source: 'command' } : { model: null, source: null }
}

/**
 * What a Composer model pick has to do to the conversation's persisted override.
 *
 * `undefined` means "leave the conversation alone": with no Project default and no existing override,
 * the model `send` carries is the one that runs, so pinning it would copy a value down that nobody
 * asked to fix. Otherwise the override has to move, because a stale override or a Project default
 * outranks the command's model and would silently ignore the pick (spec §5.3).
 */
export function modelOverrideAfterPick(
  pick: ModelRef | null,
  project: Project | undefined,
  current: ModelRef | null,
): ModelRef | null | undefined {
  const projectModel = project?.provider_id != null && project.model_id != null
    ? { provider_id: project.provider_id, model_id: project.model_id }
    : null
  if (!pick) return projectModel || current ? null : undefined
  if (projectModel && projectModel.provider_id === pick.provider_id && projectModel.model_id === pick.model_id) return null
  if (projectModel || current) return pick
  return undefined
}

/** The unsent configuration of a conversation that does not exist yet (spec §5.2). */
export interface ConversationDraft {
  project_id: number | null
  system_prompt: string
  /** The conversation's persisted model override, not the model this turn will use. */
  model: ModelRef | null
  params: ConversationParams | null
  /** The new Conversation's immutable tool snapshot. */
  tools?: string[]
}

export interface SendInput {
  conversationId: number | null
  parentId: number | null
  parts: Part[]
  /** The model this generation will use, whichever layer it came from. */
  model: ModelRef
  draft: ConversationDraft
}

/**
 * The first message creates the conversation and writes the draft in one command (spec §5.2). Every
 * init field is omitted once the conversation exists: the hub rejects the whole command when any of
 * them is merely `!== undefined`, so nulling them out would break every follow-up send.
 */
export function sendCommandFor({ conversationId, parentId, parts, model, draft }: SendInput): SendCommand {
  const command: SendCommand = {
    type: 'send',
    conversation_id: conversationId,
    parent_id: parentId,
    parts,
    provider_id: model.provider_id,
    model_id: model.model_id,
  }
  if (conversationId !== null) return command
  return {
    ...command,
    project_id: draft.project_id,
    system_prompt: blankToNull(draft.system_prompt),
    params: draft.params,
    conversation_provider_id: draft.model?.provider_id ?? null,
    conversation_model_id: draft.model?.model_id ?? null,
    tools: [...new Set(draft.tools ?? [])].sort(),
  }
}

/**
 * The model `regenerate` and `edit` carry. Only a command-layer selection travels: the hub's own
 * command layer for both is a *past* generation's model, so a pick made after that generation would
 * be silently ignored. A conversation- or Project-layer model stays implicit — the hub resolves the
 * same value and keeps naming that layer when the model turns out to be unavailable.
 *
 * Every other setting these commands rerun with — prompt, params, tools — is already persisted on the
 * conversation by the time they are sent, and the hub reads it fresh; the model is the one layer the
 * client may hold only locally (see `modelOverrideAfterPick`), so it is the one that has to be sent.
 */
function commandModel(effective: EffectiveModel): { provider_id: number; model_id: string } | undefined {
  if (effective.source !== 'command' || !effective.model) return undefined
  return { provider_id: effective.model.provider_id, model_id: effective.model.model_id }
}

export function regenerateCommandFor(messageId: number, effective: EffectiveModel): RegenerateCommand {
  return { type: 'regenerate', message_id: messageId, ...commandModel(effective) }
}

export function editCommandFor(messageId: number, parts: Part[], effective: EffectiveModel): EditCommand {
  return { type: 'edit', message_id: messageId, parts, ...commandModel(effective) }
}

/**
 * Shown when a command could not be handed to an open socket. It reads like a server rejection
 * because it occupies the same slot (spec §9): the point is that something visible happens, rather
 * than a button latching on a round trip that was never started.
 */
export const DISCONNECTED_MESSAGE = '连接已断开，请等待重新连接后重试'

/**
 * A `send` is outstanding from the moment it leaves until its message shows up, the command is
 * rejected, the wait times out, or the chat it belonged to is left behind.
 */
export type OutstandingSend = 'idle' | 'outstanding'
export type SendEvent = 'send' | 'landed' | 'error' | 'timeout' | 'abandoned'
/** What the Composer must do with the copy it kept of the submitted message. */
export type SendEffect = 'none' | 'confirm' | 'restore'

export interface SendStep {
  state: OutstandingSend
  effect: SendEffect
}

export function optimisticUserMessage(input: {
  id: number
  conversationId: number
  parentId: number | null
  parts: Part[]
  createdAt: number
}): Message {
  return {
    id: input.id,
    conversation_id: input.conversationId,
    parent_id: input.parentId,
    seq: Number.MAX_SAFE_INTEGER,
    role: 'user',
    parts: input.parts.map(part => ({ ...part })),
    provider_id: null,
    model_id: null,
    usage: null,
    status: 'done',
    error: null,
    created_at: input.createdAt,
  }
}

export function withOptimisticUserMessage(path: Message[], optimistic: Message | null): Message[] {
  return optimistic ? [...path, optimistic] : path
}

export type OptimisticMutation =
  | { kind: 'message'; message: Message }
  | { kind: 'tool_result'; messageId: number; part: ToolResultPart }

/**
 * The whole rule as a pure reducer; the view only performs the effect. Only a rejection puts the
 * message back (spec §9). Landing, giving up and leaving all end the wait and drop the copy, which
 * is also what releases its object URLs — an outstanding send is never carried into another chat,
 * where its text would otherwise be restored into a Composer it does not belong to.
 */
export function nextSendState(state: OutstandingSend, event: SendEvent): SendStep {
  switch (event) {
    // A second send supersedes the first: the Composer already replaced the copy it kept.
    case 'send': return { state: 'outstanding', effect: 'none' }
    case 'error': return state === 'outstanding' ? { state: 'idle', effect: 'restore' } : { state: 'idle', effect: 'none' }
    case 'landed':
    case 'timeout':
    case 'abandoned': return state === 'outstanding' ? { state: 'idle', effect: 'confirm' } : { state: 'idle', effect: 'none' }
  }
}

/**
 * What the Composer shows after a rejection. Neither side may be lost: whatever the user started
 * typing during the wait stays, and the rejected message comes back above it, blank line between.
 * An empty box therefore restores the message exactly as it was written.
 */
export function mergeRestoredText(restored: string, current: string): string {
  return [restored, current].filter((t) => t.trim() !== '').join('\n\n')
}

/** What the assistant bubble shows before its first visible token (spec §7.4). */
export interface AssistantWaitState {
  /** Spinner plus 正在思考…: the reply is live but has produced no visible text yet. */
  waiting: boolean
  /** Only what the provider actually returned; nothing is synthesised or inferred. */
  showReasoning: boolean
  /** Expanded while waiting, collapsed into 思考过程 as soon as the text starts. */
  reasoningOpen: boolean
}

export function assistantWaitState(message: Pick<Message, 'role' | 'status' | 'parts'>): AssistantWaitState {
  const hasText = message.parts.some((p) => p.type === 'text' && p.text.trim() !== '')
  const showReasoning = message.parts.some((p) => p.type === 'reasoning' && p.text.trim() !== '')
  const waiting = message.role === 'assistant' && message.status === 'streaming' && !hasText
  return { waiting, showReasoning, reasoningOpen: waiting && showReasoning }
}

/** Moving a chat out of a Project sends an explicit `null`; an omitted field would be a no-op. */
export function moveConversationCommand(conversationId: number, projectId: number | null): WsCommand {
  return { type: 'conversation.update', conversation_id: conversationId, project_id: projectId }
}

function pathToRoot(byId: Map<number, Message>, headId: number | null): Message[] {
  const out: Message[] = []
  let cur = headId === null ? undefined : byId.get(headId)
  const seen = new Set<number>()
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.push(cur); cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id) }
  return out.reverse()
}

export const useSyncStore = defineStore('sync', () => {
  const status = ref<WsStatus>('closed')
  // Bumped at the end of every `snapshot` application. `status` flips to `open` before the
  // snapshot event arrives, so a reload keyed on `status` can race ahead of it; watchers should
  // key on this instead to reload only once the snapshot has actually landed.
  const snapshotSeq = ref(0)
  const conversations = reactive(new Map<number, Conversation>())
  const projects = reactive(new Map<number, Project>())
  const messages = reactive(new Map<number, Map<number, Message>>())
  const loadedMessageConversations = reactive(new Set<number>())
  const streamingIds = reactive(new Set<number>())
  const forkResult = ref<{ request_id: string, conversation_id: number } | null>(null)
  const settings = ref<UserSettings>({ plugins: {} })
  const lastError = ref<string | null>(null)
  // Whether the Projects list has been fetched. Before it has, a Project id from a route cannot be
  // judged missing — only absent — and must not be silently dropped.
  const projectsLoaded = ref(false)
  const conversationsLoaded = ref(false)
  const settingsLoaded = ref(false)
  const conversationsError = ref<string | null>(null)
  const projectsError = ref<string | null>(null)
  const settingsError = ref<string | null>(null)
  const client = shallowRef<WsClient | null>(null)
  const optimisticMutations = reactive(new Map<string, OptimisticMutation>())
  let loadEpoch = 0

  function reset(): void {
    loadEpoch++
    client.value?.close()
    client.value = null
    status.value = 'closed'
    snapshotSeq.value = 0
    conversations.clear()
    projects.clear()
    messages.clear()
    loadedMessageConversations.clear()
    streamingIds.clear()
    optimisticMutations.clear()
    forkResult.value = null
    settings.value = { plugins: {} }
    lastError.value = null
    projectsLoaded.value = false
    conversationsLoaded.value = false
    settingsLoaded.value = false
    conversationsError.value = null
    projectsError.value = null
    settingsError.value = null
  }

  function beginOptimistic(requestId: string, mutation: OptimisticMutation): void {
    optimisticMutations.set(requestId, mutation)
  }

  function confirmOptimistic(requestId: string): void {
    optimisticMutations.delete(requestId)
  }

  function rejectOptimistic(requestId: string): void {
    optimisticMutations.delete(requestId)
  }

  function abandonOptimistic(requestId: string): void {
    optimisticMutations.delete(requestId)
  }

  function optimisticToolResult(messageId: number, callId: string): ToolResultPart | undefined {
    for (const mutation of optimisticMutations.values()) {
      if (mutation.kind === 'tool_result' && mutation.messageId === messageId && mutation.part.call_id === callId) {
        return mutation.part
      }
    }
    return undefined
  }

  function optimisticToolCallIds(messageId: number): Set<string> {
    return new Set([...optimisticMutations.values()].flatMap(mutation => (
      mutation.kind === 'tool_result' && mutation.messageId === messageId ? [mutation.part.call_id] : []
    )))
  }

  const orderedConversations = computed(() => [...conversations.values()].sort((a, b) => b.updated_at - a.updated_at))
  const conversationList = computed(() => orderedConversations.value.filter(conversation => (conversation.kind ?? 'chat') === 'chat'))
  const imageConversationList = computed(() => orderedConversations.value.filter(conversation => conversation.kind === 'image'))
  const projectList = computed(() => [...projects.values()].sort((a, b) => b.updated_at - a.updated_at))

  /** Sidebar grouping: pass `null` for the unprojected Chats section. Inherits `conversationList`'s
   *  newest-first order, so a Project row's first entry is its latest chat. */
  function conversationsInProject(projectId: number | null): Conversation[] {
    return conversationList.value.filter((s) => s.project_id === projectId)
  }

  function bucket(conversationId: number): Map<number, Message> {
    let b = messages.get(conversationId)
    if (!b) { b = reactive(new Map<number, Message>()); messages.set(conversationId, b) }
    return b
  }

  function findMessage(id: number): Message | undefined {
    for (const b of messages.values()) { const m = b.get(id); if (m) return m }
    return undefined
  }

  function upsertMessage(m: Message): void {
    const b = bucket(m.conversation_id)
    const existing = b.get(m.id)
    if (existing && streamingIds.has(m.id)) {
      // While the id is in the streaming set nothing may replace the live row: neither a stale
      // REST/terminal row nor a repeated `streaming` shell (which would drop accumulated parts).
      // `snapshot` reconciles the set on reconnect, which is what lets a terminal row land.
      return
    }
    b.set(m.id, { ...m, parts: m.parts.map((p) => ({ ...p })) })
    if (m.status === 'streaming') streamingIds.add(m.id)
  }

  function ingestMessages(conversationId: number, rows: Message[]): void {
    for (const r of rows) upsertMessage({ ...r, conversation_id: conversationId })
  }

  function ingestConversations(rows: Conversation[]): void {
    for (const conversation of rows) conversations.set(conversation.id, conversation)
  }

  function applyEvent(e: WsEvent): void {
    switch (e.type) {
      case 'snapshot':
        // Authoritative: streams that finished while we were offline must leave the set, so a
        // REST reload can overwrite them.
        streamingIds.clear()
        for (const m of e.inflight) { streamingIds.add(m.id); bucket(m.conversation_id).set(m.id, m) }
        snapshotSeq.value++
        break
      case 'conversation.created':
      case 'conversation.updated':
        conversations.set(e.conversation.id, e.conversation)
        break
      case 'conversation.deleted': {
        conversations.delete(e.conversation_id)
        for (const id of messages.get(e.conversation_id)?.keys() ?? []) streamingIds.delete(id)
        messages.delete(e.conversation_id)
        loadedMessageConversations.delete(e.conversation_id)
        break
      }
      case 'conversation.forked':
        forkResult.value = { request_id: e.request_id, conversation_id: e.conversation_id }
        break
      case 'message.created':
        upsertMessage(e.message)
        break
      case 'message.delta': {
        const m = findMessage(e.message_id)
        if (!m) return
        const parts = m.parts as Part[]
        while (parts.length <= e.part_index) parts.push({ type: e.kind, text: '' } as Part)
        const p = parts[e.part_index]!
        if (p.type === 'text' || p.type === 'reasoning') p.text += e.delta
        break
      }
      case 'message.part': {
        if (e.part.type === 'tool_result') {
          for (const [requestId, mutation] of optimisticMutations) {
            if (mutation.kind === 'tool_result' && mutation.messageId === e.message_id && mutation.part.call_id === e.part.call_id) {
              confirmOptimistic(requestId)
            }
          }
        }
        const m = findMessage(e.message_id)
        if (!m) return
        while (m.parts.length <= e.part_index) m.parts.push({ type: 'text', text: '' })
        m.parts[e.part_index] = e.part
        break
      }
      case 'message.done': {
        const m = findMessage(e.message_id)
        if (m) { m.status = e.status; m.usage = e.usage; m.error = e.error }
        streamingIds.delete(e.message_id)
        break
      }
      case 'head.changed': {
        const s = conversations.get(e.conversation_id)
        if (s) s.head_message_id = e.message_id
        break
      }
      case 'settings.updated':
        settings.value = e.settings
        break
      case 'project.created':
      case 'project.updated':
        projects.set(e.project.id, e.project)
        break
      case 'project.deleted': {
        // No optimistic deletion (spec §9): this only runs once the server confirms. The
        // `conversation.updated` broadcast that follows carries the authoritative post-delete row;
        // nulling it here too keeps a conversation reachable through this event alone (e.g. offline).
        projects.delete(e.project_id)
        for (const s of conversations.values()) if (s.project_id === e.project_id) s.project_id = null
        break
      }
      case 'error':
        if (e.request_id) rejectOptimistic(e.request_id)
        lastError.value = e.message
        break
    }
  }

  function pathFor(conversationId: number): Message[] {
    const s = conversations.get(conversationId)
    const b = messages.get(conversationId)
    if (!s || !b) return []
    return pathToRoot(b as Map<number, Message>, s.head_message_id)
  }

  function siblingsOf(conversationId: number, messageId: number): Message[] {
    const b = messages.get(conversationId)
    const m = b?.get(messageId)
    if (!b || !m) return []
    return [...b.values()].filter((x) => x.parent_id === m.parent_id).sort((a, c) => a.seq - c.seq)
  }

  /**
   * The message a branch shows when it is selected: its deepest descendant along newest children.
   *
   * Shared so that clicking a node on the conversation map and pressing the branch arrows under a
   * message are one action — switching to a sibling must not truncate whatever followed it.
   */
  function leafOf(conversationId: number, messageId: number): number {
    const branch = messages.get(conversationId)
    let current = branch?.get(messageId)
    if (!branch || !current) return messageId
    for (;;) {
      const child = [...branch.values()].filter(candidate => candidate.parent_id === current!.id).sort((a, b) => b.seq - a.seq)[0]
      if (!child) return current.id
      current = child
    }
  }

  function isStreaming(conversationId: number): boolean {
    return pathFor(conversationId).some((m) => streamingIds.has(m.id))
  }

  async function loadConversations(): Promise<void> {
    const epoch = loadEpoch
    conversationsError.value = null
    try {
      const rows = await api.conversations()
      if (epoch !== loadEpoch) return
      ingestConversations(rows)
      conversationsLoaded.value = true
    } catch (error) {
      if (epoch === loadEpoch) conversationsError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async function loadProjects(): Promise<void> {
    const epoch = loadEpoch
    projectsError.value = null
    try {
      const rows = await api.projects()
      if (epoch !== loadEpoch) return
      for (const p of rows) projects.set(p.id, p)
      projectsLoaded.value = true
    } catch (error) {
      if (epoch === loadEpoch) projectsError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async function loadSettings(): Promise<void> {
    const epoch = loadEpoch
    settingsError.value = null
    try {
      const result = await api.me()
      if (epoch !== loadEpoch) return
      settings.value = result.settings
      settingsLoaded.value = true
    } catch (error) {
      if (epoch === loadEpoch) settingsError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async function loadMessages(conversationId: number): Promise<void> {
    const epoch = loadEpoch
    const rows = await api.messages(conversationId)
    if (epoch !== loadEpoch) return
    ingestMessages(conversationId, rows)
    loadedMessageConversations.add(conversationId)
  }

  function connect(): void {
    if (client.value) return
    const next = new WsClient('/ws', {
      onEvent: event => { if (client.value === next) applyEvent(event) },
      onStatus: nextStatus => { if (client.value === next) status.value = nextStatus },
      onAuthLost: () => { if (client.value === next) useAuthStore().clear() },
    })
    client.value = next
    next.connect()
  }

  /**
   * False means the command was not handed over at all — there is no client yet, so it was dropped
   * on the floor and no `error` event will ever arrive to explain it. Callers that latch UI state
   * on a round trip must unlatch it themselves (spec §9).
   */
  function send(cmd: WsCommand): boolean {
    if (!client.value) return false
    client.value.send(cmd)
    return true
  }

  return {
    status, snapshotSeq, conversations, projects, messages, streamingIds, forkResult, settings, lastError, projectsLoaded, conversationsLoaded, settingsLoaded,
    optimisticMutations,
    conversationsError, projectsError, settingsError, loadedMessageConversations, conversationList, imageConversationList, projectList,
    applyEvent, ingestConversations, ingestMessages, conversationsInProject, pathFor, siblingsOf, leafOf, isStreaming, loadConversations, loadProjects, loadSettings, loadMessages, connect, reset, send,
    beginOptimistic, confirmOptimistic, rejectOptimistic, abandonOptimistic, optimisticToolResult, optimisticToolCallIds,
  }
})
