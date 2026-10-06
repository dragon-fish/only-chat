import type { CatalogProviderSummary, ModelRef } from '@/shared/api'
import type { ModelListItem, ModelQuery, Project, ProviderWithInterfaces, Conversation, Message, Usage } from '@/shared/models'
import { lastCheckpointIndex } from '@/shared/checkpoint'

export type EnabledModelEntry = {
  provider: ProviderWithInterfaces
  model: ModelListItem
}

const normalizeQuery = (query: string) => query.trim().toLocaleLowerCase()
const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(item => item.segment)
const isEmoji = (value: string) => /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)

export function projectPresentation(name: string): { icon: string | null, title: string } {
  const value = name.trim()
  const first = graphemes(value)[0]
  if (!first || !isEmoji(first)) return { icon: null, title: value }
  return { icon: first, title: value.slice(first.length).trimStart() || value }
}

export function conversationPath(conversation: Pick<Conversation, 'id' | 'project_id'>): string {
  return conversation.project_id === null ? `/c/${conversation.id}` : `/project/${conversation.project_id}/c/${conversation.id}`
}

/**
 * Where an open conversation belongs when the route it is shown under names another Project — it
 * was moved in, out or across, or opened from a stale link — or null when the route is right. The
 * sidebar and page title follow the route, so a conversation left under the wrong one splits the
 * view from them.
 */
export function canonicalConversationPath(routeProjectId: number | null, conversation: Pick<Conversation, 'id' | 'project_id'>): string | null {
  return routeProjectId === conversation.project_id ? null : conversationPath(conversation)
}

/** Builds a stable avatar fallback without depending on the host's default locale. */
export function displayInitials(name: string, fallback = 'AI'): string {
  const value = name.trim()
  if (!value) return fallback
  const words = value.split(/\s+/).filter(Boolean)
  const first = graphemes(value)[0]
  if (first && isEmoji(first)) return first
  const initials = words.length > 1
    ? words.slice(0, 2).map(word => graphemes(word)[0] ?? '').join('')
    : graphemes(value).slice(0, 2).join('')
  return initials.toUpperCase()
}

/** Returns the newest activity timestamp belonging to a Project or one of its conversations. */
export function projectActivity(project: Project, conversations: readonly Conversation[]): number {
  return conversations.reduce(
    (latest, conversation) => conversation.project_id === project.id ? Math.max(latest, conversation.updated_at) : latest,
    project.updated_at,
  )
}

export function recentProjects(
  projects: readonly Project[],
  conversations: readonly Conversation[],
  limit = 5,
): Project[] {
  return projects
    .map((project, index) => ({ project, activity: projectActivity(project, conversations), index }))
    .sort((a, b) => b.activity - a.activity || b.project.id - a.project.id || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ project }) => project)
}

export function searchProjects(projects: readonly Project[], query: string): Project[] {
  const normalized = normalizeQuery(query)
  return projects.filter(project => !normalized || project.name.toLocaleLowerCase().includes(normalized))
}

export function searchConversations(
  conversations: readonly Conversation[],
  query: string,
  projectId?: number | null,
): Conversation[] {
  const normalized = normalizeQuery(query)
  return conversations.filter(conversation => {
    const inScope = projectId === undefined || conversation.project_id === projectId
    return inScope && (!normalized || conversation.title.toLocaleLowerCase().includes(normalized))
  })
}

export const MODEL_CAPABILITY_FILTERS = [
  { key: 'vision', label: '图片输入' }, { key: 'pdf', label: 'PDF 输入' },
  { key: 'audio', label: '音频输入' }, { key: 'video', label: '视频输入' },
  { key: 'reasoning', label: '推理' },
  { key: 'tools', label: '工具' }, { key: 'image_output', label: '图片输出' },
] as const

export function modelName(model: ModelListItem): string {
  return model.metadata.name ?? model.model_id
}

export function modelBadges(model: ModelListItem) {
  const metadata = model.metadata
  const values = {
    vision: metadata.modalities?.input.includes('image'),
    pdf: metadata.modalities?.input.includes('pdf'),
    audio: metadata.modalities?.input.includes('audio'),
    video: metadata.modalities?.input.includes('video'),
    reasoning: metadata.reasoning,
    tools: metadata.tool_call, image_output: metadata.modalities?.output.includes('image'),
  }
  return MODEL_CAPABILITY_FILTERS.filter(option => values[option.key] === true)
}

export function filterModelEntries(entries: readonly EnabledModelEntry[], query: Partial<ModelQuery>, searchProviders = true): EnabledModelEntry[] {
  const search = normalizeQuery(query.search ?? '')
  return entries.filter(({ model, provider }) => {
    if (query.enabled !== undefined && model.enabled !== query.enabled) return false
    if (query.interface_id !== undefined && (model.interface_id ?? provider.default_interface_id) !== query.interface_id) return false
    if (query.lab_id !== undefined && model.lab_id !== query.lab_id) return false
    if (query.vision !== undefined && model.metadata.modalities?.input.includes('image') !== query.vision) return false
    for (const modality of ['pdf', 'audio', 'video'] as const) {
      if (query[modality] !== undefined && model.metadata.modalities?.input.includes(modality) !== query[modality]) return false
    }
    if (query.reasoning !== undefined && model.metadata.reasoning !== query.reasoning) return false
    if (query.tools !== undefined && model.metadata.tool_call !== query.tools) return false
    if (query.image_output !== undefined && model.metadata.modalities?.output.includes('image') !== query.image_output) return false
    if (query.min_context !== undefined && (model.metadata.limit?.context ?? -1) < query.min_context) return false
    if (search && ![model.model_id, model.metadata.name, model.lab_id, ...(searchProviders ? [provider.name] : [])]
      .some(value => value?.toLocaleLowerCase().includes(search))) return false
    return true
  })
}

export function sortModelEntries(
  entries: readonly EnabledModelEntry[],
  providers: readonly ProviderWithInterfaces[],
  mode: 'provider' | 'lab',
): EnabledModelEntry[] {
  const providerOrder = new Map(providers.map((provider, index) => [provider.id, index]))
  return [...entries].sort((left, right) => {
    const provider = (providerOrder.get(left.provider.id) ?? Number.MAX_SAFE_INTEGER)
      - (providerOrder.get(right.provider.id) ?? Number.MAX_SAFE_INTEGER)
    if (provider) return provider
    if (mode === 'lab') {
      if (left.model.lab_id === null && right.model.lab_id !== null) return 1
      if (left.model.lab_id !== null && right.model.lab_id === null) return -1
      const lab = (left.model.lab_id ?? '').localeCompare(right.model.lab_id ?? '')
      if (lab) return lab
    }
    return left.model.sort - right.model.sort || left.model.id - right.model.id
  })
}

export function messageUsageMetrics(usage: Usage): { cachedPercent: number | null, tokensPerSecond: number | null } {
  return {
    cachedPercent: usage.cached !== undefined && usage.prompt !== undefined && usage.prompt > 0
      ? usage.cached / usage.prompt * 100
      : null,
    tokensPerSecond: usage.completion !== undefined && usage.generation_duration_ms !== undefined && usage.generation_duration_ms > 0
      ? usage.completion / usage.generation_duration_ms * 1000
      : null,
  }
}

/**
 * Keep the previous turn's known context visible while the same model is producing its successor.
 *
 * `'pending'` after a checkpoint until a reply after it reports usage: every number before it
 * measured a context the model no longer receives, and the checkpoint's own usage is what writing
 * the summary cost — reading either as the context size shows a full gauge on an emptied context.
 */
export function latestAssistantContextUsage(path: readonly Message[], model: ModelRef): Usage | 'pending' | null {
  const cut = lastCheckpointIndex(path)
  const tail = cut === null ? path : path.slice(cut + 1)
  if (cut !== null && !tail.some(message => message.role === 'assistant' && message.usage)) return 'pending'
  const assistants = [...tail].reverse().filter(message => message.role === 'assistant')
  const latest = assistants[0]
  if (!latest || latest.provider_id !== model.provider_id || latest.model_id !== model.model_id) return null
  if (latest.usage) return latest.usage
  if (latest.status !== 'streaming') return null
  const previous = assistants[1]
  if (!previous || previous.provider_id !== model.provider_id || previous.model_id !== model.model_id) return null
  return previous.usage
}

/**
 * How full the conversation is, which is the last round trip and not the turn.
 *
 * A turn's totals are the sum over its round trips, each of which resent the whole conversation:
 * reading them as a context size pins the gauge at several hundred percent and tells the operator
 * the conversation is full when it has room. Turns recorded before steps were kept have only the
 * totals, and for a single round trip the two are the same number anyway.
 */
export function messageContextUsage(usage: Usage, limit: number): { used: number, limit: number, percent: number } | null {
  const last = usage.steps?.at(-1)
  const prompt = last?.prompt ?? usage.prompt
  const completion = last?.completion ?? usage.completion
  if (prompt === undefined || completion === undefined || limit <= 0) return null
  const used = prompt + completion
  return { used, limit, percent: used / limit * 100 }
}

const tokenNumbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** A token count at a glance: `950`, `12.5k`, `1.2M`. */
export function compactTokenCount(value: number): string {
  if (value >= 1_000_000) return `${tokenNumbers.format(value / 1_000_000)}M`
  if (value >= 1_000) return `${tokenNumbers.format(value / 1_000)}k`
  return tokenNumbers.format(value)
}

/**
 * Messages the model no longer receives: everything before the last checkpoint on the path,
 * which replays as its summary instead (spec context-compaction §1.2).
 */
export function messagesBehindCheckpoint(path: readonly Message[]): Set<number> {
  const cut = lastCheckpointIndex(path)
  return new Set(cut === null ? [] : path.slice(0, cut).map(message => message.id))
}

export function labName(id: string, catalogProviders: readonly CatalogProviderSummary[] = []): string {
  return catalogProviders.find(provider => provider.id === id)?.name
    ?? id.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

export interface ModelLabGroup { id: string | null; heading: string | null; entries: EnabledModelEntry[] }
export interface ModelProviderGroup { provider: ProviderWithInterfaces; labs: ModelLabGroup[] }

/** Lab identity is resolved on the server independently from model facts. Never infer it here. */
export function groupModelEntries(entries: readonly EnabledModelEntry[], catalogProviders: readonly CatalogProviderSummary[] = []): ModelProviderGroup[] {
  const providers = new Map<number, ModelProviderGroup>()
  for (const entry of entries) {
    let group = providers.get(entry.provider.id)
    if (!group) { group = { provider: entry.provider, labs: [] }; providers.set(entry.provider.id, group) }
    let lab = group.labs.find(lab => lab.id === entry.model.lab_id)
    if (!lab) { lab = { id: entry.model.lab_id, heading: null, entries: [] }; group.labs.push(lab) }
    lab.entries.push(entry)
  }
  for (const group of providers.values()) {
    if (group.labs.length > 1) for (const lab of group.labs) lab.heading = lab.id === null ? '其他' : labName(lab.id, catalogProviders)
  }
  return [...providers.values()]
}
