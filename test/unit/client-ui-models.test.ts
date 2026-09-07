import { describe, expect, it } from 'vitest'
import type { ModelCapabilities, Project, Provider, Session } from '@/shared/models'
import {
  displayInitials,
  filterModelEntries,
  recentProjects,
  searchProjects,
  searchSessions,
} from '@/client/lib/ui-models'

const project = (id: number, updated_at: number): Project => ({
  id, user_id: 1, name: `Project ${id}`, system_prompt: null,
  provider_id: null, model_id: null, params: null,
  created_at: updated_at, updated_at,
})

const session = (id: number, project_id: number | null, updated_at: number, title = `Session ${id}`): Session => ({
  id, user_id: 1, project_id, title, head_message_id: null,
  provider_id: null, model_id: null, system_prompt: null, params: null,
  created_at: updated_at, updated_at, archived_at: null,
})

const entry = (providerName: string, model_id: string, display_name: string, capabilities: ModelCapabilities) => ({
  provider: { id: providerName.length, user_id: 1, name: providerName, protocol: 'openai-responses', base_url: '', enabled: true, has_key: true, native_files: false, extra: null, created_at: 0 } satisfies Provider,
  model: { id: model_id.length, provider_id: providerName.length, model_id, display_name, capabilities, pricing: null, enabled: true, sort: 0 },
})

describe('navigation view models', () => {
  it('derives initials with locale-independent casing', () => {
    expect(displayInitials('istanbul intelligence')).toBe('II')
  })

  it('orders Projects by their newest own or child-session activity and limits to five', () => {
    const projects = [project(1, 10), project(2, 20), project(3, 30), project(4, 40), project(5, 50), project(6, 60)]
    const sessions = [session(1, 1, 100), session(2, 2, 90)]
    expect(recentProjects(projects, sessions).map(p => p.id)).toEqual([1, 2, 6, 5, 4])
  })

  it('uses Project id as a deterministic tie-breaker', () => {
    expect(recentProjects([project(2, 10), project(1, 10)], []).map(p => p.id)).toEqual([2, 1])
  })

  it('searches Projects with trimmed, case-insensitive substring matching', () => {
    const projects = [project(1, 10), { ...project(2, 20), name: 'Design System' }]
    expect(searchProjects(projects, '  DESIGN ')).toEqual([projects[1]])
    expect(searchProjects(projects, ' ')).toEqual(projects)
  })

  it('scopes session search when a Project id is supplied', () => {
    const sessions = [session(1, 7, 30, 'Design notes'), session(2, null, 20, 'Design question')]
    expect(searchSessions(sessions, 'design', 7).map(s => s.id)).toEqual([1])
    expect(searchSessions(sessions, 'design').map(s => s.id)).toEqual([1, 2])
    expect(searchSessions(sessions, 'design', null).map(s => s.id)).toEqual([2])
  })

  it('matches provider, display name, model id, and declared capabilities', () => {
    const entries = [
      entry('ZenMux', 'google/gemini', 'Gemini Flash', { vision: true }),
      entry('DeepSeek', 'deepseek-chat', 'DeepSeek V4', { reasoning: true }),
    ]
    expect(filterModelEntries(entries, 'zen', 'all')).toEqual([entries[0]])
    expect(filterModelEntries(entries, 'deepseek-chat', 'reasoning')).toEqual([entries[1]])
    expect(filterModelEntries(entries, '', 'vision')).toEqual([entries[0]])
  })
})
