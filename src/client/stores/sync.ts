import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import { WsClient, type WsStatus } from '@/client/lib/ws-client'
import type { ModelRef } from '@/shared/api'
import type { Message, Project, ReasoningEffort, Session, SessionParams, UserSettings } from '@/shared/models'
import type { Part } from '@/shared/parts'
import type { WsCommand, WsEvent } from '@/shared/ws'

/**
 * `inherit` leaves both reasoning keys out of the params so the Project inherits from the
 * provider/model default; `auto` turns reasoning on without sending an effort (spec §3.3).
 */
export type ProjectReasoningChoice = 'inherit' | 'off' | 'auto' | ReasoningEffort

/** What the Project settings form holds. Only `name` is required (spec §3.1); every other field
 *  may be blank, and blank must travel as `null`/absent rather than as a copied inherited value. */
export interface ProjectFormState {
  name: string
  system_prompt: string
  model: ModelRef | null
  temperature: string
  top_p: string
  max_tokens: string
  reasoning: ProjectReasoningChoice
}

/** Blank stays blank: an unparseable or empty box contributes no key at all. */
function optionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

function reasoningParams(choice: ProjectReasoningChoice): SessionParams {
  if (choice === 'inherit') return {}
  if (choice === 'off') return { reasoning_enabled: false }
  return { reasoning_enabled: true, reasoning_effort: choice === 'auto' ? null : choice }
}

/** `null` when the user filled nothing in, so the Project's `params` column stays NULL. */
export function projectParamsFromForm(form: ProjectFormState): SessionParams | null {
  const temperature = optionalNumber(form.temperature)
  const top_p = optionalNumber(form.top_p)
  const max_tokens = optionalNumber(form.max_tokens)
  const params: SessionParams = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(top_p === undefined ? {} : { top_p }),
    ...(max_tokens === undefined ? {} : { max_tokens }),
    ...reasoningParams(form.reasoning),
  }
  return Object.keys(params).length === 0 ? null : params
}

function numberToField(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/** A merged control over two independently stored keys (spec §3.3). */
function reasoningChoiceOf(params: SessionParams): ProjectReasoningChoice {
  if (params.reasoning_enabled === false) return 'off'
  if (params.reasoning_enabled === undefined && params.reasoning_effort === undefined) return 'inherit'
  return params.reasoning_effort ?? 'auto'
}

/**
 * The inverse of `projectUpdateCommand`: what the settings form shows for a stored Project.
 * Absent values render as blank fields, never as the inherited value they would resolve to.
 * `undefined` yields the blank form, so switching Projects resets through one canonical shape
 * instead of a hand-written list of fields that can drift as the form grows.
 */
export function projectFormFrom(project: Project | undefined): ProjectFormState {
  const params = project?.params ?? {}
  return {
    name: project?.name ?? '',
    system_prompt: project?.system_prompt ?? '',
    model: project && project.provider_id !== null && project.model_id !== null
      ? { provider_id: project.provider_id, model_id: project.model_id }
      : null,
    temperature: numberToField(params.temperature),
    top_p: numberToField(params.top_p),
    max_tokens: numberToField(params.max_tokens),
    reasoning: reasoningChoiceOf(params),
  }
}

/** The prompt is stored verbatim — trimming is only used to decide whether it is empty (spec §3.2). */
export function projectUpdateCommand(projectId: number, form: ProjectFormState): WsCommand {
  return {
    type: 'project.update',
    project_id: projectId,
    name: form.name.trim(),
    system_prompt: form.system_prompt.trim() === '' ? null : form.system_prompt,
    provider_id: form.model?.provider_id ?? null,
    model_id: form.model?.model_id ?? null,
    params: projectParamsFromForm(form),
  }
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
  const streamingIds = reactive(new Set<number>())
  const settings = ref<UserSettings>({ plugins: {} })
  const lastError = ref<string | null>(null)
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
        break
      }
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
    for (const s of await api.sessions()) sessions.set(s.id, s)
  }

  async function loadProjects(): Promise<void> {
    for (const p of await api.projects()) projects.set(p.id, p)
  }

  async function loadMessages(sessionId: number): Promise<void> {
    ingestMessages(sessionId, await api.messages(sessionId))
  }

  function connect(): void {
    if (client.value) return
    client.value = new WsClient('/ws', {
      onEvent: applyEvent,
      onStatus: (s) => { status.value = s },
    })
    client.value.connect()
  }

  function send(cmd: WsCommand): void {
    client.value?.send(cmd)
  }

  return {
    status, snapshotSeq, sessions, projects, messages, streamingIds, settings, lastError, sessionList, projectList,
    applyEvent, ingestMessages, sessionsInProject, pathFor, siblingsOf, isStreaming, loadSessions, loadProjects, loadMessages, connect, send,
  }
})
