import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { moveSessionCommand, projectFormFrom, projectParamsFromForm, projectUpdateCommand, useSyncStore, type ProjectFormState } from '@/client/stores/sync'
import type { Message, Project, Session } from '@/shared/models'
import { parseCommand } from '@/shared/ws'

const session: Session = { id: 1, user_id: 1, project_id: null, title: 't', head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null }
const project: Project = { id: 1, user_id: 1, name: 'p', system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 1, updated_at: 1 }
const msg = (id: number, parent_id: number | null, role: 'user' | 'assistant', over: Partial<Message> = {}): Message =>
  ({ id, session_id: 1, parent_id, seq: id, role, parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, ...over })
const mkSession = (id: number, over: Partial<Session> = {}): Session => ({ ...session, id, title: `s${id}`, updated_at: id, ...over })
const mkProject = (id: number, over: Partial<Project> = {}): Project => ({ ...project, id, name: `p${id}`, updated_at: id, ...over })
/** Every optional field blank: this is what the settings form holds for a name-only Project. */
const blankForm: ProjectFormState = { name: '  研究  ', system_prompt: '', model: null, temperature: '', top_p: '', max_tokens: '', reasoning: 'inherit' }

describe('sync store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('applies session and message events idempotently', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'session.created', session })
    expect(s.sessionList).toHaveLength(1)
    s.applyEvent({ type: 'message.created', message: msg(1, null, 'user') })
    s.applyEvent({ type: 'message.created', message: msg(2, 1, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'head.changed', session_id: 1, message_id: 2 })
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

  it('keeps streaming state when REST data arrives with a stale status', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'snapshot', inflight: [msg(5, 4, 'assistant', { status: 'streaming', parts: [{ type: 'text', text: 'partial' }] })] })
    s.ingestMessages(1, [msg(4, null, 'user'), msg(5, 4, 'assistant', { status: 'error', error: 'interrupted' })])
    expect(s.messages.get(1)!.get(5)).toMatchObject({ status: 'streaming', parts: [{ type: 'text', text: 'partial' }] })
  })

  it('reconciles the streaming set from a snapshot so a finished stream can be overwritten', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'message.created', message: msg(4, null, 'user') })
    s.applyEvent({ type: 'message.created', message: msg(5, 4, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'head.changed', session_id: 1, message_id: 5 })
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
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'message.created', message: msg(2, null, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 0, kind: 'text', delta: 'Hi' })
    s.applyEvent({ type: 'message.created', message: msg(2, null, 'assistant', { status: 'streaming' }) })
    expect(s.messages.get(1)!.get(2)!.parts).toEqual([{ type: 'text', text: 'Hi' }])
    expect(s.streamingIds.has(2)).toBe(true)
  })

  it('drops the streaming ids of a deleted session', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'message.created', message: msg(7, null, 'assistant', { status: 'streaming' }) })
    expect(s.streamingIds.has(7)).toBe(true)
    s.applyEvent({ type: 'session.deleted', session_id: 1 })
    expect(s.streamingIds.has(7)).toBe(false)
    expect(s.streamingIds.size).toBe(0)
  })

  it('computes siblings for the branch switcher', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.ingestMessages(1, [msg(1, null, 'user'), msg(2, 1, 'assistant'), msg(3, 1, 'assistant')])
    expect(s.siblingsOf(1, 3).map((m) => m.id)).toEqual([2, 3])
  })

  it('removes a deleted session and its messages', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.ingestMessages(1, [msg(1, null, 'user')])
    s.applyEvent({ type: 'session.deleted', session_id: 1 })
    expect(s.sessions.size).toBe(0)
    expect(s.messages.has(1)).toBe(false)
  })

  it('applies project events idempotently and, without optimistic deletion, moves the project’s sessions back to Chats when it is deleted', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'project.created', project })
    s.applyEvent({ type: 'project.created', project })
    expect(s.projects.get(project.id)).toEqual(project)
    expect(s.projectList).toEqual([project])

    const renamed: Project = { ...project, name: 'renamed', updated_at: 2 }
    s.applyEvent({ type: 'project.updated', project: renamed })
    expect(s.projects.get(project.id)).toEqual(renamed)

    s.applyEvent({ type: 'session.created', session: { ...session, project_id: project.id } })
    s.applyEvent({ type: 'project.deleted', project_id: project.id })
    expect(s.projects.has(project.id)).toBe(false)
    expect(s.sessions.get(session.id)?.project_id).toBeNull()
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

  it('groups sessions under their project and keeps unprojected ones in Chats', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'project.created', project: mkProject(1) })
    s.applyEvent({ type: 'project.created', project: mkProject(2) })
    for (const row of [
      mkSession(10, { project_id: 1, updated_at: 10 }),
      mkSession(11, { project_id: 1, updated_at: 30 }),
      mkSession(12, { project_id: 2, updated_at: 20 }),
      mkSession(13, { project_id: null, updated_at: 40 }),
      mkSession(14, { project_id: null, updated_at: 5 }),
    ]) s.applyEvent({ type: 'session.created', session: row })

    expect(s.sessionsInProject(1).map((x) => x.id)).toEqual([11, 10])
    expect(s.sessionsInProject(2).map((x) => x.id)).toEqual([12])
    expect(s.sessionsInProject(null).map((x) => x.id)).toEqual([13, 14])
    // A Project with no chats renders the placeholder row, so the empty list must be reachable.
    expect(s.sessionsInProject(3)).toEqual([])
  })

  it('moves a session into a project and back out to Chats', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'project.created', project: mkProject(1) })
    s.applyEvent({ type: 'session.created', session: mkSession(10) })
    expect(s.sessionsInProject(null).map((x) => x.id)).toEqual([10])

    // Moving out must send an explicit `null`, never an omitted field: omitting it would leave
    // the session in its Project (spec §7.1).
    expect(moveSessionCommand(10, 1)).toEqual({ type: 'session.update', session_id: 10, project_id: 1 })
    expect(moveSessionCommand(10, null)).toEqual({ type: 'session.update', session_id: 10, project_id: null })
    expect(parseCommand(JSON.stringify(moveSessionCommand(10, null)))).toEqual({ type: 'session.update', session_id: 10, project_id: null })

    s.applyEvent({ type: 'session.updated', session: mkSession(10, { project_id: 1 }) })
    expect(s.sessionsInProject(1).map((x) => x.id)).toEqual([10])
    expect(s.sessionsInProject(null)).toEqual([])

    s.applyEvent({ type: 'session.updated', session: mkSession(10, { project_id: null }) })
    expect(s.sessionsInProject(1)).toEqual([])
    expect(s.sessionsInProject(null).map((x) => x.id)).toEqual([10])
  })

  it('returns a deleted project’s chats to the Chats section', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'project.created', project: mkProject(1) })
    s.applyEvent({ type: 'session.created', session: mkSession(10, { project_id: 1 }) })
    s.applyEvent({ type: 'session.created', session: mkSession(11, { project_id: 1 }) })
    expect(s.sessionsInProject(null)).toEqual([])

    s.applyEvent({ type: 'project.deleted', project_id: 1 })
    expect(s.projectList).toEqual([])
    expect(s.sessionsInProject(null).map((x) => x.id)).toEqual([11, 10])
    expect(s.sessions.size).toBe(2)
  })

  it('sends null for every optional Project setting left empty', () => {
    // Nothing may be copied from an inherited default just because the form rendered it (spec §3.1).
    expect(projectParamsFromForm(blankForm)).toBeNull()
    expect(projectUpdateCommand(7, blankForm)).toEqual({
      type: 'project.update', project_id: 7, name: '研究',
      system_prompt: null, provider_id: null, model_id: null, params: null,
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
      name: 'Weekly report', system_prompt: '  keep\n  the indent  ', model: { provider_id: 2, model_id: 'gpt-5.1' },
      temperature: '0.7', top_p: '', max_tokens: '2048', reasoning: 'high',
    }
    const cmd = projectUpdateCommand(7, form)
    expect(cmd).toEqual({
      type: 'project.update', project_id: 7, name: 'Weekly report',
      system_prompt: '  keep\n  the indent  ', provider_id: 2, model_id: 'gpt-5.1',
      params: { temperature: 0.7, max_tokens: 2048, reasoning_enabled: true, reasoning_effort: 'high' },
    })
    expect(parseCommand(JSON.stringify(cmd))).toEqual(cmd)
  })
})

describe('project settings form state', () => {
  const configured: Project = {
    ...project, id: 1, name: 'A', system_prompt: 'A prompt', provider_id: 2, model_id: 'gpt-5.1',
    params: { temperature: 0.7, top_p: 0.9, max_tokens: 2048, reasoning_enabled: true, reasoning_effort: 'high' },
  }
  const bare: Project = { ...project, id: 2, name: 'B' }

  it('renders a name-only project as blank fields rather than inherited values', () => {
    expect(projectFormFrom(bare)).toEqual({ name: 'B', system_prompt: '', model: null, temperature: '', top_p: '', max_tokens: '', reasoning: 'inherit' })
    // `undefined` is the canonical empty form the view resets through.
    expect(projectFormFrom(undefined)).toEqual({ name: '', system_prompt: '', model: null, temperature: '', top_p: '', max_tokens: '', reasoning: 'inherit' })
  })

  it('round-trips a configured project through the form without changing anything', () => {
    expect(projectUpdateCommand(configured.id, projectFormFrom(configured))).toEqual({
      type: 'project.update', project_id: 1, name: 'A', system_prompt: 'A prompt', provider_id: 2, model_id: 'gpt-5.1',
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
      system_prompt: null, provider_id: null, model_id: null, params: null,
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
