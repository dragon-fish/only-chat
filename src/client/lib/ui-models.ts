import type { CatalogProviderSummary } from '@/shared/api'
import type { ModelWithMetadata, Project, ProviderWithInterfaces, Conversation, Usage } from '@/shared/models'

export type EnabledModelEntry = {
  provider: ProviderWithInterfaces
  model: ModelWithMetadata
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
  { key: 'vision', label: '视觉' }, { key: 'reasoning', label: '推理' },
  { key: 'tools', label: '工具' }, { key: 'image_output', label: '图片输出' },
] as const

export function modelName(model: ModelWithMetadata): string {
  return model.metadata.name ?? model.model_id
}

export function modelBadges(model: ModelWithMetadata) {
  const metadata = model.metadata
  const values = {
    vision: metadata.modalities?.input.includes('image'), reasoning: metadata.reasoning,
    tools: metadata.tool_call, image_output: metadata.modalities?.output.includes('image'),
  }
  return MODEL_CAPABILITY_FILTERS.filter(option => values[option.key] === true)
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

export function messageContextUsage(usage: Usage, limit: number): { used: number, limit: number, percent: number } | null {
  if (usage.prompt === undefined || usage.completion === undefined || limit <= 0) return null
  const used = usage.prompt + usage.completion
  return { used, limit, percent: used / limit * 100 }
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
