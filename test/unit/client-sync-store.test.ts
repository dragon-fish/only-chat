import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  REASONING_LABELS,
  REASONING_ORDER,
  assistantWaitState,
  choiceFromParams,
  choiceToParams,
  effectiveModelFor,
  fieldLooksBlank,
  mergeRestoredText,
  modelOverrideAfterPick,
  moveConversationCommand,
  nextSendState,
  optimisticUserMessage,
  paramsFromFields,
  projectFormFrom,
  projectParamsFromForm,
  projectUpdateCommand,
  reasoningChipLabel,
  reasoningChoiceFor,
  reasoningControlModel,
  reasoningDisabledReason,
  reasoningStopsFor,
  sendCommandFor,
  regenerateCommandFor,
  editCommandFor,
  conversationFormFrom,
  conversationSettingSources,
  type OutstandingSend,
  type ParamFields,
  type ProjectFormState,
  type ReasoningStop,
  type SendEvent,
  type ConversationConfigSource,
  useSyncStore,
  withOptimisticUserMessage,
} from '@/client/stores/sync'
import type { ModelRef } from '@/shared/api'
import type { Message, Project, Conversation } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { parseCommand } from '@/shared/ws'

const conversation: Conversation = { id: 1, user_id: 1, project_id: null, title: 't', head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], created_at: 1, updated_at: 1, archived_at: null }
const project: Project = { id: 1, user_id: 1, name: 'p', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 1, updated_at: 1 }
const msg = (id: number, parent_id: number | null, role: 'user' | 'assistant', over: Partial<Message> = {}): Message =>
  ({ id, conversation_id: 1, parent_id, seq: id, role, parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, ...over })
const mkConversation = (id: number, over: Partial<Conversation> = {}): Conversation => ({ ...conversation, id, title: `s${id}`, updated_at: id, ...over })
const mkProject = (id: number, over: Partial<Project> = {}): Project => ({ ...project, id, name: `p${id}`, updated_at: id, ...over })
/** Every optional field blank: this is what the settings form holds for a name-only Project. */
const blankForm: ProjectFormState = { name: '  研究  ', icon_attachment_id: null, system_prompt: '', model: null, temperature: '', top_p: '', max_tokens: '', reasoning: 'inherit' }

describe('sync store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('applies conversation and message events idempotently', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'conversation.created', conversation })
    s.applyEvent({ type: 'conversation.created', conversation })
    expect(s.conversationList).toHaveLength(1)
    s.applyEvent({ type: 'message.created', message: msg(1, null, 'user') })
    s.applyEvent({ type: 'message.created', message: msg(2, 1, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'head.changed', conversation_id: 1, message_id: 2 })
    expect(s.streamingIds.has(2)).toBe(true)
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 0, kind: 'reasoning', delta: 'hm' })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 1, kind: 'text', delta: 'Hi' })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 1, kind: 'text', delta: '!' })
    expect(s.messages.get(1)!.get(2)!.parts).toEqual([{ type: 'reasoning', text: 'hm' }, { type: 'text', text: 'Hi!' }])
    s.applyEvent({ type: 'message.done', message_id: 2, status: 'done', usage: { prompt: 1 }, error: null })
    expect(s.messages.get(1)!.get(2)).toMatchObject({ status: 'done', usage: { prompt: 1 } })
    expect(s.streamingIds.has(2)).toBe(false)
    expect(s.pathFor(1).map((m) => m.id)).toEqual([1, 2])
  })

  it('reports a command that no socket ever took', () => {
    const s = useSyncStore()
    // `connect()` has not run, so nothing takes the command and no `error` event will ever arrive to
    // explain it. A caller that latches UI state on the round trip has to learn that here.
    expect(s.send({ type: 'stop', conversation_id: 1 })).toBe(false)
  })

  it('keeps streaming state when REST data arrives with a stale status', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'conversation.created', conversation })
    s.applyEvent({ type: 'snapshot', inflight: [msg(5, 4, 'assistant', { status: 'streaming', parts: [{ type: 'text', text: 'partial' }] })] })
    s.ingestMessages(1, [msg(4, null, 'user'), msg(5, 4, 'assistant', { status: 'error', error: 'interrupted' })])
    expect(s.messages.get(1)!.get(5)).toMatchObject({ status: 'streaming', parts: [{ type: 'text', text: 'partial' }] })
  })

  it('reconciles the streaming set from a snapshot so a finished stream can be overwritten', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'conversation.created', conversation })
    s.applyEvent({ type: 'message.created', message: msg(4, null, 'user') })
    s.applyEvent({ type: 'message.created', message: msg(5, 4, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'head.changed', conversation_id: 1, message_id: 5 })
    expect(s.streamingIds.has(5)).toBe(true)
    // Reconnect: the stream finished while we were offline, so the snapshot no longer lists it.
    expect(s.snapshotSeq).toBe(0)
    s.applyEvent({ type: 'snapshot', inflight: [] })
    expect(s.streamingIds.has(5)).toBe(false)
    expect(s.snapshotSeq).toBe(1)
    s.ingestMessages(1, [msg(4, null, 'user'), msg(5, 4, 'assistant', { status: 'done', parts: [{ type: 'text', text: 'final' }] })])
    expect(s.messages.get(1)!.get(5)).toMatchObject({ status: 'done', parts: [{ type: 'text', text: 'final' }] })
    expect(s.isStreaming(1)).toBe(false)
    s.applyEvent({ type: 'snapshot', inflight: [] })
    expect(s.snapshotSeq).toBe(2)
  })

  it('ignores a duplicate streaming shell so accumulated parts survive', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'conversation.created', conversation })
    s.applyEvent({ type: 'message.created', message: msg(2, null, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 0, kind: 'text', delta: 'Hi' })
    s.applyEvent({ type: 'message.created', message: msg(2, null, 'assistant', { status: 'streaming' }) })
    expect(s.messages.get(1)!.get(2)!.parts).toEqual([{ type: 'text', text: 'Hi' }])
    expect(s.streamingIds.has(2)).toBe(true)
  })

  it('drops the streaming ids of a deleted conversation', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'conversation.created', conversation })
    s.applyEvent({ type: 'message.created', message: msg(7, null, 'assistant', { status: 'streaming' }) })
    expect(s.streamingIds.has(7)).toBe(true)
    s.applyEvent({ type: 'conversation.deleted', conversation_id: 1 })
    expect(s.streamingIds.has(7)).toBe(false)
    expect(s.streamingIds.size).toBe(0)
  })

  it('computes siblings for the branch switcher', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'conversation.created', conversation })
    s.ingestMessages(1, [msg(1, null, 'user'), msg(2, 1, 'assistant'), msg(3, 1, 'assistant')])
    expect(s.siblingsOf(1, 3).map((m) => m.id)).toEqual([2, 3])
  })

  it('removes a deleted conversation and its messages', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'conversation.created', conversation })
    s.ingestMessages(1, [msg(1, null, 'user')])
    s.applyEvent({ type: 'conversation.deleted', conversation_id: 1 })
    expect(s.conversations.size).toBe(0)
    expect(s.messages.has(1)).toBe(false)
  })

  it('applies project events idempotently and, without optimistic deletion, moves the project’s conversations back to Chats when it is deleted', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'project.created', project })
    s.applyEvent({ type: 'project.created', project })
    expect(s.projects.get(project.id)).toEqual(project)
    expect(s.projectList).toEqual([project])

    const renamed: Project = { ...project, name: 'renamed', updated_at: 2 }
    s.applyEvent({ type: 'project.updated', project: renamed })
    expect(s.projects.get(project.id)).toEqual(renamed)

    s.applyEvent({ type: 'conversation.created', conversation: { ...conversation, project_id: project.id } })
    s.applyEvent({ type: 'project.deleted', project_id: project.id })
    expect(s.projects.has(project.id)).toBe(false)
    expect(s.conversations.get(conversation.id)?.project_id).toBeNull()
  })
})

describe('project navigation view-model', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('sorts projects by updated_at descending', () => {
    const s = useSyncStore()
    for (const p of [mkProject(1, { updated_at: 10 }), mkProject(2, { updated_at: 30 }), mkProject(3, { updated_at: 20 })]) {
      s.applyEvent({ type: 'project.created', project: p })
    }
    expect(s.projectList.map((p) => p.id)).toEqual([2, 3, 1])
  })

  it('groups conversations under their project and keeps unprojected ones in Chats', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'project.created', project: mkProject(1) })
    s.applyEvent({ type: 'project.created', project: mkProject(2) })
    for (const row of [
      mkConversation(10, { project_id: 1, updated_at: 10 }),
      mkConversation(11, { project_id: 1, updated_at: 30 }),
      mkConversation(12, { project_id: 2, updated_at: 20 }),
      mkConversation(13, { project_id: null, updated_at: 40 }),
      mkConversation(14, { project_id: null, updated_at: 5 }),
    ]) s.applyEvent({ type: 'conversation.created', conversation: row })

    expect(s.conversationsInProject(1).map((x) => x.id)).toEqual([11, 10])
    expect(s.conversationsInProject(2).map((x) => x.id)).toEqual([12])
    expect(s.conversationsInProject(null).map((x) => x.id)).toEqual([13, 14])
    // A Project with no chats renders the placeholder row, so the empty list must be reachable.
    expect(s.conversationsInProject(3)).toEqual([])
  })

  it('moves a conversation into a project and back out to Chats', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'project.created', project: mkProject(1) })
    s.applyEvent({ type: 'conversation.created', conversation: mkConversation(10) })
    expect(s.conversationsInProject(null).map((x) => x.id)).toEqual([10])

    // Moving out must send an explicit `null`, never an omitted field: omitting it would leave
    // the conversation in its Project (spec §7.1).
    expect(moveConversationCommand(10, 1)).toEqual({ type: 'conversation.update', conversation_id: 10, project_id: 1 })
    expect(moveConversationCommand(10, null)).toEqual({ type: 'conversation.update', conversation_id: 10, project_id: null })
    expect(parseCommand(JSON.stringify(moveConversationCommand(10, null)))).toEqual({ type: 'conversation.update', conversation_id: 10, project_id: null })

    s.applyEvent({ type: 'conversation.updated', conversation: mkConversation(10, { project_id: 1 }) })
    expect(s.conversationsInProject(1).map((x) => x.id)).toEqual([10])
    expect(s.conversationsInProject(null)).toEqual([])

    s.applyEvent({ type: 'conversation.updated', conversation: mkConversation(10, { project_id: null }) })
    expect(s.conversationsInProject(1)).toEqual([])
    expect(s.conversationsInProject(null).map((x) => x.id)).toEqual([10])
  })

  it('returns a deleted project’s chats to the Chats section', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'project.created', project: mkProject(1) })
    s.applyEvent({ type: 'conversation.created', conversation: mkConversation(10, { project_id: 1 }) })
    s.applyEvent({ type: 'conversation.created', conversation: mkConversation(11, { project_id: 1 }) })
    expect(s.conversationsInProject(null)).toEqual([])

    s.applyEvent({ type: 'project.deleted', project_id: 1 })
    expect(s.projectList).toEqual([])
    expect(s.conversationsInProject(null).map((x) => x.id)).toEqual([11, 10])
    expect(s.conversations.size).toBe(2)
  })

  it('sends null for every optional Project setting left empty', () => {
    // Nothing may be copied from an inherited default just because the form rendered it (spec §3.1).
    expect(projectParamsFromForm(blankForm)).toBeNull()
    expect(projectUpdateCommand(7, blankForm)).toEqual({
      type: 'project.update', project_id: 7, name: '研究',
      icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null,
    })
    expect(parseCommand(JSON.stringify(projectUpdateCommand(7, blankForm)))).toMatchObject({ params: null, model_id: null })
  })

  it('keeps only the parameters the user actually filled in', () => {
    const params = projectParamsFromForm({ ...blankForm, temperature: '0.7' })
    expect(params).toEqual({ temperature: 0.7 })
    expect(Object.keys(params!)).toEqual(['temperature'])
  })

  it('maps the reasoning choice onto the enabled/effort pair', () => {
    expect(projectParamsFromForm({ ...blankForm, reasoning: 'off' })).toEqual({ reasoning_enabled: false })
    expect(projectParamsFromForm({ ...blankForm, reasoning: 'auto' })).toEqual({ reasoning_enabled: true, reasoning_effort: null })
    expect(projectParamsFromForm({ ...blankForm, reasoning: 'xhigh' })).toEqual({ reasoning_enabled: true, reasoning_effort: 'xhigh' })
    // `inherit` leaves both keys absent so the Project itself inherits from the provider default.
    expect(projectParamsFromForm({ ...blankForm, reasoning: 'inherit', top_p: '0.9' })).toEqual({ top_p: 0.9 })
  })

  it('builds a complete update command without rewriting the prompt', () => {
    const form: ProjectFormState = {
      name: 'Weekly report', icon_attachment_id: null, system_prompt: '  keep\n  the indent  ', model: { provider_id: 2, model_id: 'gpt-5.1' },
      temperature: '0.7', top_p: '', max_tokens: '2048', reasoning: 'high',
    }
    const cmd = projectUpdateCommand(7, form)
    expect(cmd).toEqual({
      type: 'project.update', project_id: 7, name: 'Weekly report',
      icon_attachment_id: null, system_prompt: '  keep\n  the indent  ', provider_id: 2, model_id: 'gpt-5.1',
      params: { temperature: 0.7, max_tokens: 2048, reasoning_enabled: true, reasoning_effort: 'high' },
    })
    expect(parseCommand(JSON.stringify(cmd))).toEqual(cmd)
  })
})

describe('project settings form state', () => {
  const configured: Project = {
    ...project, id: 1, name: 'A', icon_attachment_id: null, system_prompt: 'A prompt', provider_id: 2, model_id: 'gpt-5.1',
    params: { temperature: 0.7, top_p: 0.9, max_tokens: 2048, reasoning_enabled: true, reasoning_effort: 'high' },
  }
  const bare: Project = { ...project, id: 2, name: 'B' }

  it('renders a name-only project as blank fields rather than inherited values', () => {
    expect(projectFormFrom(bare)).toEqual({ name: 'B', icon_attachment_id: null, system_prompt: '', model: null, temperature: '', top_p: '', max_tokens: '', reasoning: 'inherit' })
    // `undefined` is the canonical empty form the view resets through.
    expect(projectFormFrom(undefined)).toEqual({ name: '', icon_attachment_id: null, system_prompt: '', model: null, temperature: '', top_p: '', max_tokens: '', reasoning: 'inherit' })
  })

  it('round-trips a configured project through the form without changing anything', () => {
    expect(projectUpdateCommand(configured.id, projectFormFrom(configured))).toEqual({
      type: 'project.update', project_id: 1, name: 'A', icon_attachment_id: null, system_prompt: 'A prompt', provider_id: 2, model_id: 'gpt-5.1',
      params: { temperature: 0.7, top_p: 0.9, max_tokens: 2048, reasoning_enabled: true, reasoning_effort: 'high' },
    })
  })

  it('leaves nothing of the previous project behind when the form switches projects', () => {
    // The settings page reuses one form object across Projects, so a partial refill would save the
    // Project the user opened first onto the Project they opened second.
    const form: ProjectFormState = projectFormFrom(configured)
    Object.assign(form, projectFormFrom(bare))
    expect(projectUpdateCommand(bare.id, form)).toEqual({
      type: 'project.update', project_id: 2, name: 'B',
      icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null,
    })
  })

  it('reads the merged reasoning control back out of the stored pair', () => {
    const withParams = (params: Project['params']): Project => ({ ...bare, params })
    expect(projectFormFrom(withParams({ reasoning_enabled: false })).reasoning).toBe('off')
    expect(projectFormFrom(withParams({ reasoning_enabled: true, reasoning_effort: null })).reasoning).toBe('auto')
    expect(projectFormFrom(withParams({ reasoning_enabled: true, reasoning_effort: 'xhigh' })).reasoning).toBe('xhigh')
    expect(projectFormFrom(withParams({ temperature: 1 })).reasoning).toBe('inherit')
  })
})

describe('reasoning control', () => {
  it('maps every slider stop onto the independent enabled/effort pair', () => {
    // `inherit` is the only choice that writes nothing at all: both keys stay absent so the layer
    // below decides (spec §3.3).
    expect(choiceToParams('inherit')).toEqual({})
    expect(choiceToParams('off')).toEqual({ reasoning_enabled: false })
    expect(choiceToParams('auto')).toEqual({ reasoning_enabled: true, reasoning_effort: null })
    expect(choiceToParams('xhigh')).toEqual({ reasoning_enabled: true, reasoning_effort: 'xhigh' })
    for (const stop of REASONING_ORDER) {
      if (stop === 'off' || stop === 'auto') continue
      expect(choiceToParams(stop)).toEqual({ reasoning_enabled: true, reasoning_effort: stop })
    }
  })

  it('labels the stops in slider order', () => {
    expect([...REASONING_ORDER]).toEqual(['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(REASONING_ORDER.map((s) => REASONING_LABELS[s])).toEqual(['立即', '自动', '极低', '低', '中', '高', '超高', 'Max', 'Ultra'])
    // The labels the brief names, resolved back to the params they must produce.
    const byLabel = (label: string) => REASONING_ORDER.find((s) => REASONING_LABELS[s] === label)!
    expect(choiceToParams(byLabel('立即'))).toEqual({ reasoning_enabled: false })
    expect(choiceToParams(byLabel('自动'))).toEqual({ reasoning_enabled: true, reasoning_effort: null })
    expect(choiceToParams(byLabel('超高'))).toEqual({ reasoning_enabled: true, reasoning_effort: 'xhigh' })
  })

  it('reads the stored pair back as one choice, keeping explicit Auto distinct from inherit', () => {
    expect(choiceFromParams(null)).toBe('inherit')
    expect(choiceFromParams({})).toBe('inherit')
    expect(choiceFromParams({ temperature: 1 })).toBe('inherit')
    expect(choiceFromParams({ reasoning_enabled: false })).toBe('off')
    expect(choiceFromParams({ reasoning_enabled: true, reasoning_effort: null })).toBe('auto')
    expect(choiceFromParams({ reasoning_enabled: true, reasoning_effort: 'high' })).toBe('high')
    // Enabled and effort inherit independently: an effort on its own is still an explicit strength.
    expect(choiceFromParams({ reasoning_effort: 'low' })).toBe('low')
  })

  it('keeps undeclared reasoning options conservative without inventing effort levels', () => {
    expect(reasoningStopsFor({})).toEqual([])
    expect(reasoningStopsFor(undefined)).toEqual([])
    expect(reasoningStopsFor({ reasoning: true })).toEqual(['auto'])
    expect(reasoningStopsFor({ reasoning: true, reasoning_options: [] })).toEqual(['auto'])
    expect(reasoningStopsFor({ reasoning: true, reasoning_options: [{ type: 'effort', values: [null, 'default'] }] })).toEqual(['auto'])
  })

  it('derives exact efforts and disable support from reasoning_options', () => {
    expect(reasoningStopsFor({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['ultra', 'low', 'medium', 'default', null] }] })).toEqual(['auto', 'low', 'medium', 'ultra'])
    expect(reasoningStopsFor({ reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['high'] }] })).toEqual(['off', 'auto', 'high'])
    expect(reasoningStopsFor({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low'] }] })).toEqual(['off', 'auto', 'low'])
    expect(reasoningStopsFor({ reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 10000 }] })).toEqual(['auto'])
    expect(reasoningStopsFor({ reasoning: false, reasoning_options: [{ type: 'toggle' }] })).toEqual([])
  })
})

describe('conversation settings form', () => {
  const fields: ParamFields = { temperature: '', top_p: '', max_tokens: '', reasoning: 'inherit' }

  it('holds only what the conversation itself overrides, never an inherited value', () => {
    expect(conversationFormFrom(undefined)).toEqual({ title: '', system_prompt: '', ...fields })
    expect(conversationFormFrom({ ...conversation, title: 'T', system_prompt: 'S', params: { temperature: 0.5 } }))
      .toEqual({ title: 'T', system_prompt: 'S', ...fields, temperature: '0.5' })
  })

  it('keeps an explicit Auto through an unrelated edit', () => {
    // Regression: reading the pair back with `??` collapsed explicit Auto into inherit, so editing
    // the temperature silently deleted the user's Auto choice (spec §3.3).
    const form = conversationFormFrom({ ...conversation, params: { reasoning_enabled: true, reasoning_effort: null } })
    expect(form.reasoning).toBe('auto')
    expect(paramsFromFields({ ...form, temperature: '0.5' }))
      .toEqual({ temperature: 0.5, reasoning_enabled: true, reasoning_effort: null })
  })

  it('drops the params column entirely once every field is cleared', () => {
    expect(paramsFromFields(fields)).toBeNull()
    expect(paramsFromFields({ ...fields, max_tokens: '2048' })).toEqual({ max_tokens: 2048 })
    expect(paramsFromFields({ ...fields, reasoning: 'off' })).toEqual({ reasoning_enabled: false })
  })

  it('accepts a number, not just a string, for the numeric fields', () => {
    // Regression: `Input` renders a native `<input type="number">`, and Vue's `v-model` casts to a
    // `number` whenever the element's `type` is `"number"` — unconditionally, with no `.number`
    // modifier needed. So the value that actually reaches `form.temperature` after a real keystroke
    // is a `number`, never the `string` the old signature assumed; that call crashed with
    // `raw.trim is not a function` and aborted the commit before it ever reached `send`, so the
    // value silently never saved. `0` is deliberately included: it is falsy but not blank.
    expect(paramsFromFields({ ...fields, temperature: 0.7, top_p: 0, max_tokens: 2048 }))
      .toEqual({ temperature: 0.7, top_p: 0, max_tokens: 2048 })
    // A non-finite number (never produced by the input itself, but not this function's job to trust
    // the caller) contributes no key, same as an unparseable string.
    expect(paramsFromFields({ ...fields, temperature: Number.NaN })).toBeNull()
  })

  it('names the layer every field comes from', () => {
    const project: Project = {
      ...mkProject(3), system_prompt: 'P', provider_id: 1, model_id: 'm',
      params: { temperature: 0.2, top_p: 0.9, reasoning_enabled: true },
    }
    const bare: ConversationConfigSource = { system_prompt: null, provider_id: null, model_id: null, params: null }
    expect(conversationSettingSources(bare, project)).toEqual({
      system_prompt: 'project', model: 'project', temperature: 'project', top_p: 'project',
      max_tokens: 'default', reasoning: 'project',
    })
    expect(conversationSettingSources(bare, undefined)).toEqual({
      system_prompt: 'default', model: 'default', temperature: 'default', top_p: 'default',
      max_tokens: 'default', reasoning: 'default',
    })
    const overridden: ConversationConfigSource = {
      system_prompt: 'S', provider_id: 2, model_id: 'n',
      params: { temperature: 0, max_tokens: 8, reasoning_effort: null },
    }
    expect(conversationSettingSources(overridden, project)).toEqual({
      // `temperature: 0` and an explicit-Auto `reasoning_effort: null` are real overrides.
      system_prompt: 'conversation', model: 'conversation', temperature: 'conversation', top_p: 'project',
      max_tokens: 'conversation', reasoning: 'conversation',
    })
  })
})

describe('composer model precedence', () => {
  const picked: ModelRef = { provider_id: 9, model_id: 'picked' }
  const historical: ModelRef = { provider_id: 8, model_id: 'historical' }
  const local: ModelRef = { provider_id: 7, model_id: 'local' }
  const projectModel = mkProject(1, { provider_id: 1, model_id: 'project-model' })
  const messages: Message[] = [
    { id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: [], provider_id: 6, model_id: 'older', usage: null, status: 'done', error: null, created_at: 1 },
    { id: 2, conversation_id: 1, parent_id: 1, seq: 2, role: 'user', parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 2 },
    { id: 3, conversation_id: 1, parent_id: 2, seq: 3, role: 'assistant', parts: [], provider_id: historical.provider_id, model_id: historical.model_id, usage: null, status: 'done', error: null, created_at: 3 },
  ]

  it('shows the model the generation will actually use', () => {
    expect(effectiveModelFor(null, undefined, null)).toEqual({ model: null, source: null })
    expect(effectiveModelFor(null, undefined, picked)).toEqual({ model: picked, source: 'command' })
    expect(effectiveModelFor(null, projectModel, picked))
      .toEqual({ model: { provider_id: 1, model_id: 'project-model' }, source: 'project' })
    expect(effectiveModelFor({ provider_id: 2, model_id: 'own' }, projectModel, picked))
      .toEqual({ model: { provider_id: 2, model_id: 'own' }, source: 'conversation' })
    // A Project with no default model contributes nothing.
    expect(effectiveModelFor(null, mkProject(2), picked)).toEqual({ model: picked, source: 'command' })
  })

  it('restores an existing chat from its current branch instead of the global remembered model', () => {
    const context = { localPick: undefined, messagesLoaded: true, messages }
    expect(effectiveModelFor(null, undefined, picked, context)).toEqual({ model: historical, source: 'command' })
    expect(effectiveModelFor(null, projectModel, picked, context))
      .toEqual({ model: { provider_id: 1, model_id: 'project-model' }, source: 'project' })
  })

  it('keeps an existing chat blocked until history arrives and lets a deliberate local pick win', () => {
    expect(effectiveModelFor(null, undefined, picked, {
      localPick: undefined, messagesLoaded: false, messages: [],
    })).toEqual({ model: null, source: null })
    expect(effectiveModelFor(null, undefined, picked, {
      localPick: local, messagesLoaded: false, messages: [],
    })).toEqual({ model: local, source: 'command' })
    expect(effectiveModelFor(null, undefined, picked, {
      localPick: undefined, messagesLoaded: true, messages: [],
    })).toEqual({ model: picked, source: 'command' })
  })

  it('persists a pick as a conversation override only when `send` would otherwise ignore it', () => {
    // No Project default and no existing override: `send`'s own model is honoured (spec §5.3), so
    // nothing has to be written to the conversation.
    expect(modelOverrideAfterPick(picked, undefined, null)).toBeUndefined()
    // A Project default outranks the command model, so the pick has to become an override...
    expect(modelOverrideAfterPick(picked, projectModel, null)).toEqual(picked)
    // ...unless the pick is the Project default itself, which needs no override at all.
    expect(modelOverrideAfterPick({ provider_id: 1, model_id: 'project-model' }, projectModel, null)).toBeNull()
    // An existing override outranks the command model too, so it has to follow the pick.
    expect(modelOverrideAfterPick(picked, undefined, { provider_id: 3, model_id: 'old' })).toEqual(picked)
    // Clearing the picker restores inheritance rather than pinning "nothing".
    expect(modelOverrideAfterPick(null, projectModel, picked)).toBeNull()
  })
})

describe('branch leaf resolution', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('follows the newest child to the deepest descendant', () => {
    const store = useSyncStore()
    // 1 ─ 2 ─ 4 ─ 6      the newest child at every fork
    //   └ 3 ─ 5
    store.ingestMessages(1, [
      msg(1, null, 'user'), msg(2, 1, 'assistant'), msg(3, 1, 'assistant'),
      msg(4, 2, 'user'), msg(5, 3, 'user'), msg(6, 4, 'assistant'),
    ])
    expect(store.leafOf(1, 2)).toBe(6)
    expect(store.leafOf(1, 3)).toBe(5)
    // A leaf resolves to itself, and an unknown id is returned untouched.
    expect(store.leafOf(1, 6)).toBe(6)
    expect(store.leafOf(1, 99)).toBe(99)
  })

  it('prefers the highest seq when a node has several children', () => {
    const store = useSyncStore()
    store.ingestMessages(1, [msg(1, null, 'user'), msg(2, 1, 'assistant'), msg(7, 1, 'assistant'), msg(3, 1, 'assistant')])
    expect(store.leafOf(1, 1)).toBe(7)
  })
})

describe('regenerate and edit payload', () => {
  const picked: ModelRef = { provider_id: 9, model_id: 'picked' }
  const parts: Part[] = [{ type: 'text', text: 'redo' }]

  it('carries a command-layer pick, which the hub would otherwise ignore', () => {
    const regen = regenerateCommandFor(12, { model: picked, source: 'command' })
    expect(regen).toEqual({ type: 'regenerate', message_id: 12, provider_id: 9, model_id: 'picked' })
    expect(parseCommand(JSON.stringify(regen))).toEqual(regen)
    const edit = editCommandFor(12, parts, { model: picked, source: 'command' })
    expect(edit).toEqual({ type: 'edit', message_id: 12, parts, provider_id: 9, model_id: 'picked' })
    expect(parseCommand(JSON.stringify(edit))).toEqual(edit)
  })

  it('leaves an inherited model implicit so the hub keeps naming its layer', () => {
    const bare = { type: 'regenerate', message_id: 12 }
    expect(regenerateCommandFor(12, { model: picked, source: 'conversation' })).toEqual(bare)
    expect(regenerateCommandFor(12, { model: picked, source: 'project' })).toEqual(bare)
    expect(regenerateCommandFor(12, { model: null, source: null })).toEqual(bare)
    expect(editCommandFor(12, parts, { model: picked, source: 'project' }))
      .toEqual({ type: 'edit', message_id: 12, parts })
  })
})

describe('send payload', () => {
  const parts: Part[] = [{ type: 'text', text: 'hi' }]
  const model: ModelRef = { provider_id: 4, model_id: 'gpt' }
  const draft = { project_id: 7, system_prompt: '  keep  ', model: { provider_id: 5, model_id: 'pinned' }, params: { temperature: 0.3 }, tools: ['z', 'ask_user', 'ask_user'] }

  it('creates the conversation atomically from the draft on the first message', () => {
    const cmd = sendCommandFor({ conversationId: null, parentId: null, parts, model, draft })
    expect(cmd).toEqual({
      type: 'send', conversation_id: null, parent_id: null, parts,
      provider_id: 4, model_id: 'gpt',
      project_id: 7, system_prompt: '  keep  ', params: { temperature: 0.3 },
      conversation_provider_id: 5, conversation_model_id: 'pinned',
      tools: ['ask_user', 'z'],
    })
    expect(parseCommand(JSON.stringify(cmd))).toEqual(cmd)
  })

  it('sends an empty draft as explicit nulls rather than inherited values', () => {
    const cmd = sendCommandFor({
      conversationId: null, parentId: null, parts, model,
      draft: { project_id: null, system_prompt: '   ', model: null, params: null, tools: [] },
    })
    expect(cmd).toMatchObject({ project_id: null, system_prompt: null, params: null, conversation_provider_id: null, conversation_model_id: null, tools: [] })
  })

  it('omits every conversation-init field on a follow-up message', () => {
    // The hub rejects the whole command when any init field is present and `conversation_id` is not
    // null, so nulling them out would break every follow-up send.
    const cmd = sendCommandFor({ conversationId: 12, parentId: 34, parts, model, draft })
    expect(Object.keys(cmd).sort()).toEqual(['conversation_id', 'model_id', 'parent_id', 'parts', 'provider_id', 'type'])
    expect(cmd).toEqual({ type: 'send', conversation_id: 12, parent_id: 34, parts, provider_id: 4, model_id: 'gpt' })
    expect(parseCommand(JSON.stringify(cmd))).toEqual(cmd)
  })
})

describe('assistant wait state', () => {
  const assistant = (over: Partial<Message>): Message => msg(2, 1, 'assistant', over)

  it('waits on an empty streaming shell', () => {
    expect(assistantWaitState(assistant({ status: 'streaming', parts: [] })))
      .toEqual({ waiting: true, showReasoning: false, reasoningOpen: false })
  })

  it('keeps waiting while only a reasoning summary is streaming, and expands it', () => {
    expect(assistantWaitState(assistant({ status: 'streaming', parts: [{ type: 'reasoning', text: 'weighing' }] })))
      .toEqual({ waiting: true, showReasoning: true, reasoningOpen: true })
  })

  it('stops waiting and collapses the summary on the first text token', () => {
    const parts: Part[] = [{ type: 'reasoning', text: 'weighing' }, { type: 'text', text: 'H' }]
    expect(assistantWaitState(assistant({ status: 'streaming', parts })))
      .toEqual({ waiting: false, showReasoning: true, reasoningOpen: false })
    // An empty text part is not yet visible output, so the wait continues.
    expect(assistantWaitState(assistant({ status: 'streaming', parts: [{ type: 'text', text: '' }] })).waiting).toBe(true)
  })

  it('leaves no reasoning container behind when the summary stayed empty', () => {
    expect(assistantWaitState(assistant({ status: 'done', parts: [{ type: 'reasoning', text: '' }, { type: 'text', text: 'Hi' }] })))
      .toEqual({ waiting: false, showReasoning: false, reasoningOpen: false })
    // A finished reply never shows the spinner, even when it produced no text at all.
    expect(assistantWaitState(assistant({ status: 'error', parts: [] })).waiting).toBe(false)
    expect(assistantWaitState(msg(1, null, 'user', { status: 'streaming', parts: [] })).waiting).toBe(false)
  })
})

describe('outstanding send lifecycle', () => {
  const step = (state: OutstandingSend, event: SendEvent) => nextSendState(state, event)

  it('waits only between a send and its outcome', () => {
    expect(step('idle', 'send')).toEqual({ state: 'outstanding', effect: 'none' })
    expect(step('outstanding', 'landed')).toEqual({ state: 'idle', effect: 'confirm' })
    expect(step('outstanding', 'error')).toEqual({ state: 'idle', effect: 'restore' })
    expect(step('outstanding', 'timeout')).toEqual({ state: 'idle', effect: 'confirm' })
    expect(step('outstanding', 'abandoned')).toEqual({ state: 'idle', effect: 'confirm' })
    // A second send supersedes the first; the Composer has already replaced the copy it kept.
    expect(step('outstanding', 'send')).toEqual({ state: 'outstanding', effect: 'none' })
  })

  it('never touches the Composer when nothing is outstanding', () => {
    // Messages arrive and commands fail for reasons that have nothing to do with a send of ours:
    // opening a chat, another device's reply, a rejected conversation.update.
    for (const event of ['landed', 'error', 'timeout', 'abandoned'] as const) {
      expect(step('idle', event)).toEqual({ state: 'idle', effect: 'none' })
    }
  })

  it('drops a send that outlived the chat it belonged to', () => {
    // One component instance serves every /c/:id, so a switch has to end the wait: resolving it
    // against the next chat would restore the previous chat's message into its Composer.
    const afterSend = step('idle', 'send')
    const afterSwitch = step(afterSend.state, 'abandoned')
    expect(afterSwitch).toEqual({ state: 'idle', effect: 'confirm' })
    expect(step(afterSwitch.state, 'error').effect).toBe('none')
  })
})

describe('optimistic user messages', () => {
  it('appends a local user row immediately without mutating the confirmed path', () => {
    const confirmed = [msg(1, null, 'user')]
    const optimistic = optimisticUserMessage({
      id: -7,
      conversationId: 3,
      parentId: 1,
      parts: [{ type: 'text', text: 'instant' }],
      createdAt: 123,
    })
    expect(optimistic).toMatchObject({
      id: -7, conversation_id: 3, parent_id: 1, role: 'user', status: 'done', created_at: 123,
      parts: [{ type: 'text', text: 'instant' }],
    })
    expect(withOptimisticUserMessage(confirmed, optimistic).map(message => message.id)).toEqual([1, -7])
    expect(confirmed.map(message => message.id)).toEqual([1])
    expect(withOptimisticUserMessage(confirmed, null)).toBe(confirmed)
  })

  it('uses one lifecycle for optimistic messages and tool results', () => {
    const s = useSyncStore()
    const message = optimisticUserMessage({
      id: -1, conversationId: 3, parentId: null, parts: [{ type: 'text', text: 'pending' }], createdAt: 1,
    })
    s.beginOptimistic('message-request', { kind: 'message', message })
    expect(s.optimisticMutations.get('message-request')).toMatchObject({ kind: 'message', message: { id: -1 } })
    s.abandonOptimistic('message-request')
    expect(s.optimisticMutations.has('message-request')).toBe(false)

    const call = { type: 'tool_call' as const, id: 'call-1', name: 'ask_user', args: {} }
    s.ingestMessages(3, [msg(10, null, 'assistant', { conversation_id: 3, parts: [call] })])
    const part = {
      type: 'tool_result' as const,
      call_id: 'call-1',
      name: 'ask_user',
      content: { status: 'answered', answers: [] },
    }
    s.beginOptimistic('tool-request', { kind: 'tool_result', messageId: 10, part })
    expect(s.optimisticToolResult(10, 'call-1')).toEqual(part)
    s.applyEvent({ type: 'message.part', message_id: 10, part_index: 1, part })
    expect(s.optimisticMutations.has('tool-request')).toBe(false)

    s.beginOptimistic('rejected-tool', { kind: 'tool_result', messageId: 10, part })
    s.applyEvent({ type: 'error', request_id: 'rejected-tool', message: 'rejected' })
    expect(s.optimisticMutations.has('rejected-tool')).toBe(false)
  })
})

describe('rejected message recovery', () => {
  it('restores an untouched Composer verbatim', () => {
    expect(mergeRestoredText('  keep\n  the indent  ', '')).toBe('  keep\n  the indent  ')
    expect(mergeRestoredText('', '')).toBe('')
  })

  it('keeps both halves when the user typed during the wait', () => {
    // Neither may be lost: the rejected message is the earlier one, so it comes back above.
    expect(mergeRestoredText('rejected', 'started typing')).toBe('rejected\n\nstarted typing')
  })

  it('adds no separator when one side is empty', () => {
    // An image-only message carries no text; a blank line on its own would be a bogus edit.
    expect(mergeRestoredText('', 'started typing')).toBe('started typing')
    expect(mergeRestoredText('rejected', '   ')).toBe('rejected')
  })
})

describe('reasoningControlModel', () => {
  const FULL: ReasoningStop[] = ['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

  it('keeps off and auto off the strength axis', () => {
    const m = reasoningControlModel(FULL, 'medium')
    expect(m.strengths).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(m.index).toBe(2)
    expect(m.enabled).toBe(true)
    expect(m.auto).toBe(false)
  })

  it('reports auto as enabled with no selected strength', () => {
    const m = reasoningControlModel(FULL, 'auto')
    expect(m.auto).toBe(true)
    expect(m.enabled).toBe(true)
    expect(m.index).toBe(-1)
  })

  it('treats a fully unset value as auto, because nothing is pinned anywhere', () => {
    expect(reasoningControlModel(FULL, 'inherit').auto).toBe(true)
  })

  it('reports off', () => {
    const m = reasoningControlModel(FULL, 'off')
    expect(m.enabled).toBe(false)
    expect(m.auto).toBe(false)
    expect(m.index).toBe(-1)
  })

  it('only allows disabling when the stops say so', () => {
    expect(reasoningControlModel(FULL, 'auto').canDisable).toBe(true)
    expect(reasoningControlModel(['auto', 'low'], 'auto').canDisable).toBe(false)
  })

  // Spec §5.5: 总开关禁用并锁在「开」. The switch is disabled whenever `canDisable` is false, so if
  // `enabled` also followed the stored value the panel would render 思考 off + disabled, 自动
  // disabled and the slider disabled -- not one movable control, on a model that reasons anyway
  // because `buildProviderOptions` omits the disable value it cannot express. Locking on is what
  // keeps the rest of the panel live and stops the display contradicting the request.
  it('locks 思考 on, not at the stored value, when the axis cannot express off', () => {
    const m = reasoningControlModel(['auto', 'low', 'medium', 'high'], 'off')
    expect(m.canDisable).toBe(false)
    expect(m.enabled).toBe(true)
    // Nothing is pinned, which is exactly what 自动 means: reason, send no effort.
    expect(m.auto).toBe(true)
    expect(m.index).toBe(-1)
    // `off` is not a strength, so the lock must not be reported as an unsupported strength either.
    expect(m.unsupported).toBe(false)
  })

  // The stranding path from the review, end to end: a Project stores 思考关, a conversation inherits it,
  // and the conversation's model declares `reasoning` but not `reasoning_can_disable`.
  it('leaves the slider reachable for a conversation that inherited off from a Project', () => {
    const stops = reasoningStopsFor({ reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] })
    const m = reasoningControlModel(stops, choiceFromParams({ reasoning_enabled: false }))
    expect(m.canDisable).toBe(false)
    expect(m.enabled).toBe(true)
    expect(m.strengths.length).toBeGreaterThan(0)
    // `enabled` is what gates 自动 and the slider in the component, so both stay usable.
    expect(reasoningChoiceFor(m, { kind: 'strength', stop: 'high' })).toBe('high')
  })

  // A model that *can* disable still honours a stored off -- the lock is not a blanket override.
  it('still reports off when the axis does contain off', () => {
    expect(reasoningControlModel(FULL, 'off').enabled).toBe(false)
    expect(reasoningControlModel(FULL, 'off').auto).toBe(false)
  })

  it('flags a stored strength this model does not offer instead of rewriting it', () => {
    const m = reasoningControlModel(['auto', 'low', 'high'], 'ultra')
    expect(m.unsupported).toBe(true)
    expect(m.index).toBe(-1)
    expect(m.enabled).toBe(true)
  })

  it('does not flag auto or off as unsupported', () => {
    expect(reasoningControlModel(['auto', 'low'], 'auto').unsupported).toBe(false)
    expect(reasoningControlModel(['auto', 'low'], 'off').unsupported).toBe(false)
  })

  // A model that cannot reason yields NO stops at all, and this is the shape the chip's disabled
  // state is derived from. `unsupported` is deliberately false here -- there is no stored strength
  // being contradicted, there is simply nothing to offer -- so a caller must decide "this model
  // cannot reason" from an empty axis, never from `unsupported`.
  it('reports an empty axis, not an unsupported strength, when the model cannot reason', () => {
    const m = reasoningControlModel([], 'inherit')
    expect(m.strengths).toEqual([])
    expect(m.canDisable).toBe(false)
    expect(m.index).toBe(-1)
    expect(m.unsupported).toBe(false)
  })

  // Reasoning models that pin no strength: the axis is empty but `auto` is still meaningful.
  it('treats an auto-only model as having no strengths to slide between', () => {
    const m = reasoningControlModel(['auto'], 'auto')
    expect(m.strengths).toEqual([])
    expect(m.auto).toBe(true)
    expect(m.index).toBe(-1)
    expect(m.unsupported).toBe(false)
  })
})

describe('reasoningChoiceFor', () => {
  const FULL: ReasoningStop[] = ['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

  it('turning 思考 off writes off', () => {
    const m = reasoningControlModel(FULL, 'high')
    expect(reasoningChoiceFor(m, { kind: 'enable', on: false })).toBe('off')
  })

  it('turning 思考 on lands on auto rather than guessing a strength', () => {
    const m = reasoningControlModel(FULL, 'off')
    expect(reasoningChoiceFor(m, { kind: 'enable', on: true })).toBe('auto')
  })

  it('turning 自动 on releases the pinned strength', () => {
    const m = reasoningControlModel(FULL, 'high')
    expect(reasoningChoiceFor(m, { kind: 'auto', on: true })).toBe('auto')
  })

  it('turning 自动 off lands on the middle strength', () => {
    const m = reasoningControlModel(FULL, 'auto')
    expect(reasoningChoiceFor(m, { kind: 'auto', on: false })).toBe('high')
  })

  it('picking a stop selects it and leaves auto', () => {
    const m = reasoningControlModel(FULL, 'auto')
    expect(reasoningChoiceFor(m, { kind: 'strength', stop: 'low' })).toBe('low')
  })

  it('turning 自動 off with a single strength picks that one', () => {
    const m = reasoningControlModel(['auto', 'low'], 'auto')
    expect(reasoningChoiceFor(m, { kind: 'auto', on: false })).toBe('low')
  })
})

// Spec §5.1: the reason both hosts show. It lives here rather than in either component so the
// Composer's chip and the Project page's inline body cannot state different things -- the split
// that let the Project page render live-looking controls for a model that cannot reason at all.
describe('reasoningDisabledReason', () => {
  it('names the reason when the model declares no reasoning at all', () => {
    expect(reasoningDisabledReason(reasoningStopsFor({}))).toBe('该模型不支持推理')
    expect(reasoningDisabledReason([])).toBe('该模型不支持推理')
  })

  it('stays silent whenever there is something to control', () => {
    expect(reasoningDisabledReason(reasoningStopsFor({ reasoning: true }))).toBeNull()
    // Auto-only is still a working control: 思考 and 自动 both act, there is just no axis.
    expect(reasoningDisabledReason(['auto'])).toBeNull()
    expect(reasoningDisabledReason([...REASONING_ORDER])).toBeNull()
  })

  // The flag that must NOT be used for this: it is false exactly where the reason is needed.
  it('does not fall for the unsupported flag, which is false for a non-reasoning model', () => {
    expect(reasoningControlModel([], 'inherit').unsupported).toBe(false)
    expect(reasoningDisabledReason([])).not.toBeNull()
  })
})

describe('fieldLooksBlank', () => {
  // reka writes typed text back to the model only on blur or Enter, so between clearing a filled
  // box and leaving it, the model still holds the old value while the box reads empty. Asking the
  // model there is what let a stepper press on a visibly empty 最大 tokens commit `min` = 1 and
  // truncate every later reply to one token.
  it('believes the box over the model while the box is being edited', () => {
    expect(fieldLooksBlank('', 4096)).toBe(true)
    expect(fieldLooksBlank('   ', 4096)).toBe(true)
    expect(fieldLooksBlank('0.5', '')).toBe(false)
  })

  // reka gates its steppers on whether its parse yields NaN, and it accepts partial input on the
  // way to a number. A lone `.` passes its `onBeforeinput` and parses to NaN, so text that is not
  // yet a number must count as blank — treating it as filled is what re-opened the stepper defect.
  it('counts unparseable partial input as blank', () => {
    expect(fieldLooksBlank('.', '')).toBe(true)
    expect(fieldLooksBlank('-', '')).toBe(true)
    expect(fieldLooksBlank('1e', '')).toBe(true)
    expect(fieldLooksBlank('0.5', '')).toBe(false)
    expect(fieldLooksBlank('.5', '')).toBe(false)
  })

  it('falls back to the model when no edit is in flight', () => {
    expect(fieldLooksBlank(null, '')).toBe(true)
    expect(fieldLooksBlank(null, 4096)).toBe(false)
  })

  // Spec §7.3: blank means inherit, and 0 is a value someone chose.
  it('does not mistake zero for blank', () => {
    expect(fieldLooksBlank(null, 0)).toBe(false)
    expect(fieldLooksBlank('0', 0)).toBe(false)
  })
})

describe('reasoningChipLabel', () => {
  const FULL: ReasoningStop[] = ['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const NO_OFF: ReasoningStop[] = ['auto', 'low', 'medium', 'high']

  it('reads 立即 only where off is actually honourable', () => {
    expect(reasoningChipLabel(reasoningControlModel(FULL, 'off'), 'off')).toBe(REASONING_LABELS.off)
  })

  // The locked-on rule's only user-visible output: a model that cannot express off must not
  // display 立即, because the switch is locked on and the request does not turn reasoning off.
  it('reads 自动 for a stored off the model cannot honour', () => {
    expect(reasoningChipLabel(reasoningControlModel(NO_OFF, 'off'), 'off')).toBe(REASONING_LABELS.auto)
  })

  it('reads 自动 for inherit', () => {
    expect(reasoningChipLabel(reasoningControlModel(FULL, 'inherit'), 'inherit')).toBe(REASONING_LABELS.auto)
  })

  // Spec §5.5: shown as-is, never rewritten to a stop the user never chose.
  it('shows a stored strength the model does not offer, unrewritten', () => {
    expect(reasoningChipLabel(reasoningControlModel(NO_OFF, 'ultra'), 'ultra')).toBe(REASONING_LABELS.ultra)
  })

  it('names the selected strength', () => {
    expect(reasoningChipLabel(reasoningControlModel(FULL, 'high'), 'high')).toBe(REASONING_LABELS.high)
  })
})
