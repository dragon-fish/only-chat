import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import { WsClient, type WsStatus } from '@/client/lib/ws-client'
import type { ModelRef } from '@/shared/api'
import type { Message, Project, Session, SessionParams, UserSettings } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { Part } from '@/shared/parts'
import type { SendCommand, WsCommand, WsEvent } from '@/shared/ws'

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
export function choiceToParams(choice: ReasoningChoice): SessionParams {
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
export function choiceFromParams(params: SessionParams | null | undefined): ReasoningChoice {
  if (!params) return 'inherit'
  if (params.reasoning_enabled === false) return 'off'
  if (params.reasoning_enabled === undefined && params.reasoning_effort === undefined) return 'inherit'
  return params.reasoning_effort ?? 'auto'
}

/**
 * The generation parameters a Project and a session edit the same way. Typed `string | number`,
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
export function paramsFromFields(fields: ParamFields): SessionParams | null {
  const temperature = optionalNumber(fields.temperature)
  const top_p = optionalNumber(fields.top_p)
  const max_tokens = optionalNumber(fields.max_tokens)
  const params: SessionParams = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(top_p === undefined ? {} : { top_p }),
    ...(max_tokens === undefined ? {} : { max_tokens }),
    ...choiceToParams(fields.reasoning),
  }
  return Object.keys(params).length === 0 ? null : params
}

/** Absent values render as blank fields, never as the inherited value they would resolve to. */
export function fieldsFromParams(params: SessionParams | null | undefined): ParamFields {
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

export function projectParamsFromForm(form: ProjectFormState): SessionParams | null {
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

/** What the Composer's settings popover holds for the open session, or for an unsent draft. */
export interface SessionSettingsForm extends ParamFields {
  title: string
  system_prompt: string
}

/** Only the session's own overrides: an inherited value shown here would be copied down on save. */
export function sessionFormFrom(session: Session | undefined): SessionSettingsForm {
  return {
    title: session?.title ?? '',
    system_prompt: session?.system_prompt ?? '',
    ...fieldsFromParams(session?.params),
  }
}

/** The session-level fields inheritance reads; an unsent draft satisfies it as well as a `Session`. */
export type SessionConfigSource = Pick<Session, 'system_prompt' | 'provider_id' | 'model_id' | 'params'>

/** Which layer a field's current value comes from, for its 继承自 Project / 会话覆盖 badge (spec §7.3). */
export type SettingSource = 'session' | 'project' | 'default'

export interface SessionSettingSources {
  system_prompt: SettingSource
  model: SettingSource
  temperature: SettingSource
  top_p: SettingSource
  max_tokens: SettingSource
  reasoning: SettingSource
}

function sourceOf(inSession: boolean, inProject: boolean): SettingSource {
  return inSession ? 'session' : inProject ? 'project' : 'default'
}

/**
 * Presence decides every field: `temperature: 0` and an explicit-Auto `reasoning_effort: null` are
 * real session overrides. Reasoning reports one source for the merged control even though the two
 * keys inherit independently — either key present in a layer makes that layer the source.
 */
export function sessionSettingSources(session: SessionConfigSource, project: Project | undefined): SessionSettingSources {
  const own = session.params
  const inherited = project?.params
  const param = (key: 'temperature' | 'top_p' | 'max_tokens'): SettingSource =>
    sourceOf(own?.[key] !== undefined, inherited?.[key] !== undefined)
  const hasReasoning = (p: SessionParams | null | undefined) =>
    p?.reasoning_enabled !== undefined || p?.reasoning_effort !== undefined
  return {
    system_prompt: sourceOf(session.system_prompt !== null, (project?.system_prompt ?? null) !== null),
    model: sourceOf(
      session.provider_id !== null && session.model_id !== null,
      project?.provider_id != null && project.model_id != null,
    ),
    temperature: param('temperature'),
    top_p: param('top_p'),
    max_tokens: param('max_tokens'),
    reasoning: sourceOf(hasReasoning(own), hasReasoning(inherited)),
  }
}

/** Which layer supplies the model the next generation will use (spec §5.3). */
export type ModelSource = 'session' | 'project' | 'command'

export interface EffectiveModel {
  model: ModelRef | null
  /** `null` only when no layer supplies a model at all. */
  source: ModelSource | null
}

export interface ExistingChatModelContext {
  /** `undefined` means this page has not made a deliberate model choice for the session. */
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
 * The client's mirror of the server's precedence: session override → Project default → the model
 * this command carries. The Composer shows the result, so it never claims a model the generation
 * would not actually use.
 */
export function effectiveModelFor(
  override: ModelRef | null,
  project: Project | undefined,
  picked: ModelRef | null,
  chat?: ExistingChatModelContext,
): EffectiveModel {
  if (override) return { model: override, source: 'session' }
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
 * What a Composer model pick has to do to the session's persisted override.
 *
 * `undefined` means "leave the session alone": with no Project default and no existing override,
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

/** The unsent configuration of a session that does not exist yet (spec §5.2). */
export interface SessionDraft {
  project_id: number | null
  system_prompt: string
  /** The session's persisted model override, not the model this turn will use. */
  model: ModelRef | null
  params: SessionParams | null
  /** The new Session's immutable tool snapshot. */
  tools?: string[]
}

export interface SendInput {
  sessionId: number | null
  parentId: number | null
  parts: Part[]
  /** The model this generation will use, whichever layer it came from. */
  model: ModelRef
  draft: SessionDraft
}

/**
 * The first message creates the session and writes the draft in one command (spec §5.2). Every
 * init field is omitted once the session exists: the hub rejects the whole command when any of
 * them is merely `!== undefined`, so nulling them out would break every follow-up send.
 */
export function sendCommandFor({ sessionId, parentId, parts, model, draft }: SendInput): SendCommand {
  const command: SendCommand = {
    type: 'send',
    session_id: sessionId,
    parent_id: parentId,
    parts,
    provider_id: model.provider_id,
    model_id: model.model_id,
  }
  if (sessionId !== null) return command
  return {
    ...command,
    project_id: draft.project_id,
    system_prompt: blankToNull(draft.system_prompt),
    params: draft.params,
    session_provider_id: draft.model?.provider_id ?? null,
    session_model_id: draft.model?.model_id ?? null,
    tools: [...new Set(draft.tools ?? [])].sort(),
  }
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
export function moveSessionCommand(sessionId: number, projectId: number | null): WsCommand {
  return { type: 'session.update', session_id: sessionId, project_id: projectId }
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
  const sessions = reactive(new Map<number, Session>())
  const projects = reactive(new Map<number, Project>())
  const messages = reactive(new Map<number, Map<number, Message>>())
  const loadedMessageSessions = reactive(new Set<number>())
  const streamingIds = reactive(new Set<number>())
  const forkResult = ref<{ request_id: string, session_id: number } | null>(null)
  const settings = ref<UserSettings>({ plugins: {} })
  const lastError = ref<string | null>(null)
  // Whether the Projects list has been fetched. Before it has, a Project id from a route cannot be
  // judged missing — only absent — and must not be silently dropped.
  const projectsLoaded = ref(false)
  const sessionsLoaded = ref(false)
  const settingsLoaded = ref(false)
  const sessionsError = ref<string | null>(null)
  const projectsError = ref<string | null>(null)
  const settingsError = ref<string | null>(null)
  const client = shallowRef<WsClient | null>(null)

  const sessionList = computed(() => [...sessions.values()].sort((a, b) => b.updated_at - a.updated_at))
  const projectList = computed(() => [...projects.values()].sort((a, b) => b.updated_at - a.updated_at))

  /** Sidebar grouping: pass `null` for the unprojected Chats section. Inherits `sessionList`'s
   *  newest-first order, so a Project row's first entry is its latest chat. */
  function sessionsInProject(projectId: number | null): Session[] {
    return sessionList.value.filter((s) => s.project_id === projectId)
  }

  function bucket(sessionId: number): Map<number, Message> {
    let b = messages.get(sessionId)
    if (!b) { b = reactive(new Map<number, Message>()); messages.set(sessionId, b) }
    return b
  }

  function findMessage(id: number): Message | undefined {
    for (const b of messages.values()) { const m = b.get(id); if (m) return m }
    return undefined
  }

  function upsertMessage(m: Message): void {
    const b = bucket(m.session_id)
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

  function ingestMessages(sessionId: number, rows: Message[]): void {
    for (const r of rows) upsertMessage({ ...r, session_id: sessionId })
  }

  function applyEvent(e: WsEvent): void {
    switch (e.type) {
      case 'snapshot':
        // Authoritative: streams that finished while we were offline must leave the set, so a
        // REST reload can overwrite them.
        streamingIds.clear()
        for (const m of e.inflight) { streamingIds.add(m.id); bucket(m.session_id).set(m.id, m) }
        snapshotSeq.value++
        break
      case 'session.created':
      case 'session.updated':
        sessions.set(e.session.id, e.session)
        break
      case 'session.deleted': {
        sessions.delete(e.session_id)
        for (const id of messages.get(e.session_id)?.keys() ?? []) streamingIds.delete(id)
        messages.delete(e.session_id)
        loadedMessageSessions.delete(e.session_id)
        break
      }
      case 'session.forked':
        forkResult.value = { request_id: e.request_id, session_id: e.session_id }
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
        const s = sessions.get(e.session_id)
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
        // `session.updated` broadcast that follows carries the authoritative post-delete row;
        // nulling it here too keeps a session reachable through this event alone (e.g. offline).
        projects.delete(e.project_id)
        for (const s of sessions.values()) if (s.project_id === e.project_id) s.project_id = null
        break
      }
      case 'error':
        lastError.value = e.message
        break
    }
  }

  function pathFor(sessionId: number): Message[] {
    const s = sessions.get(sessionId)
    const b = messages.get(sessionId)
    if (!s || !b) return []
    return pathToRoot(b as Map<number, Message>, s.head_message_id)
  }

  function siblingsOf(sessionId: number, messageId: number): Message[] {
    const b = messages.get(sessionId)
    const m = b?.get(messageId)
    if (!b || !m) return []
    return [...b.values()].filter((x) => x.parent_id === m.parent_id).sort((a, c) => a.seq - c.seq)
  }

  function isStreaming(sessionId: number): boolean {
    return pathFor(sessionId).some((m) => streamingIds.has(m.id))
  }

  async function loadSessions(): Promise<void> {
    sessionsError.value = null
    try {
      for (const s of await api.sessions()) sessions.set(s.id, s)
      sessionsLoaded.value = true
    } catch (error) {
      sessionsError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async function loadProjects(): Promise<void> {
    projectsError.value = null
    try {
      for (const p of await api.projects()) projects.set(p.id, p)
      projectsLoaded.value = true
    } catch (error) {
      projectsError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async function loadSettings(): Promise<void> {
    settingsError.value = null
    try {
      settings.value = (await api.me()).settings
      settingsLoaded.value = true
    } catch (error) {
      settingsError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async function loadMessages(sessionId: number): Promise<void> {
    ingestMessages(sessionId, await api.messages(sessionId))
    loadedMessageSessions.add(sessionId)
  }

  function connect(): void {
    if (client.value) return
    client.value = new WsClient('/ws', {
      onEvent: applyEvent,
      onStatus: (s) => { status.value = s },
    })
    client.value.connect()
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
    status, snapshotSeq, sessions, projects, messages, streamingIds, forkResult, settings, lastError, projectsLoaded, sessionsLoaded, settingsLoaded,
    sessionsError, projectsError, settingsError, loadedMessageSessions, sessionList, projectList,
    applyEvent, ingestMessages, sessionsInProject, pathFor, siblingsOf, isStreaming, loadSessions, loadProjects, loadSettings, loadMessages, connect, send,
  }
})
