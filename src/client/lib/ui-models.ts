import type { Model, Project, Provider, Session } from '@/shared/models'

export type ModelCapabilityFilter = 'all' | 'vision' | 'reasoning' | 'tools' | 'image_output'

export type EnabledModelEntry = {
  provider: Provider
  model: Model
}

const normalizeQuery = (query: string) => query.trim().toLocaleLowerCase()

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

export function filterModelEntries(
  entries: readonly EnabledModelEntry[],
  query: string,
  capability: ModelCapabilityFilter,
): EnabledModelEntry[] {
  const normalized = normalizeQuery(query)
  return entries.filter(({ provider, model }) => {
    const matchesQuery = !normalized || [provider.name, model.display_name, model.model_id]
      .some(value => value.toLocaleLowerCase().includes(normalized))
    const matchesCapability = capability === 'all' || model.capabilities[capability] === true
    return matchesQuery && matchesCapability
  })
}
