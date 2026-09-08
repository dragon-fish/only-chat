import type { CatalogProviderSummary } from '@/shared/api'
import type { ModelWithMetadata, Project, ProviderWithInterfaces, Session, Usage } from '@/shared/models'

export type EnabledModelEntry = {
  provider: ProviderWithInterfaces
  model: ModelWithMetadata
}

const normalizeQuery = (query: string) => query.trim().toLocaleLowerCase()

export function sessionPath(session: Pick<Session, 'id' | 'project_id'>): string {
  return session.project_id === null ? `/c/${session.id}` : `/project/${session.project_id}/c/${session.id}`
}

/** Builds a stable avatar fallback without depending on the host's default locale. */
export function displayInitials(name: string, fallback = 'AI'): string {
  const value = name.trim()
  if (!value) return fallback
  const words = value.split(/\s+/).filter(Boolean)
  const initials = words.length > 1
    ? words.slice(0, 2).map(word => Array.from(word)[0] ?? '').join('')
    : Array.from(value).slice(0, 2).join('')
  return initials.toUpperCase()
}

/** Returns the newest activity timestamp belonging to a Project or one of its sessions. */
export function projectActivity(project: Project, sessions: readonly Session[]): number {
  return sessions.reduce(
    (latest, session) => session.project_id === project.id ? Math.max(latest, session.updated_at) : latest,
    project.updated_at,
  )
}

export function recentProjects(
  projects: readonly Project[],
  sessions: readonly Session[],
  limit = 5,
): Project[] {
  return projects
    .map((project, index) => ({ project, activity: projectActivity(project, sessions), index }))
    .sort((a, b) => b.activity - a.activity || b.project.id - a.project.id || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ project }) => project)
}

export function searchProjects(projects: readonly Project[], query: string): Project[] {
  const normalized = normalizeQuery(query)
  return projects.filter(project => !normalized || project.name.toLocaleLowerCase().includes(normalized))
}

export function searchSessions(
  sessions: readonly Session[],
  query: string,
  projectId?: number | null,
): Session[] {
  const normalized = normalizeQuery(query)
  return sessions.filter(session => {
    const inScope = projectId === undefined || session.project_id === projectId
    return inScope && (!normalized || session.title.toLocaleLowerCase().includes(normalized))
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
