import { describe, expect, it } from 'vitest'
import type { Project, Conversation } from '@/shared/models'
import {
  displayInitials,
  projectPresentation,
  recentProjects,
  searchProjects,
  searchConversations,
} from '@/client/lib/ui-models'

const project = (id: number, updated_at: number): Project => ({
  id, user_id: 1, name: `Project ${id}`, icon_attachment_id: null, system_prompt: null,
  provider_id: null, model_id: null, params: null,
  created_at: updated_at, updated_at,
})

const conversation = (id: number, project_id: number | null, updated_at: number, title = `Conversation ${id}`): Conversation => ({
  id, user_id: 1, project_id, title, head_message_id: null,
  provider_id: null, model_id: null, system_prompt: null, params: null, tools: [],
  created_at: updated_at, updated_at, archived_at: null,
})

describe('navigation view models', () => {
  it('derives initials with locale-independent casing', () => {
    expect(displayInitials('istanbul intelligence')).toBe('II')
  })

  it('uses one complete leading Emoji instead of combining it with a letter', () => {
    expect(displayInitials('🐍 emoji 测试')).toBe('🐍')
    expect(displayInitials('👩‍💻 coding')).toBe('👩‍💻')
  })

  it('presents a leading Emoji as the icon while keeping the stored name intact', () => {
    expect(projectPresentation('🐍 emoji 测试')).toEqual({ icon: '🐍', title: 'emoji 测试' })
  })

  it('orders Projects by their newest own or child-conversation activity and limits to five', () => {
    const projects = [project(1, 10), project(2, 20), project(3, 30), project(4, 40), project(5, 50), project(6, 60)]
    const conversations = [conversation(1, 1, 100), conversation(2, 2, 90)]
    expect(recentProjects(projects, conversations).map(p => p.id)).toEqual([1, 2, 6, 5, 4])
  })

  it('uses Project id as a deterministic tie-breaker', () => {
    expect(recentProjects([project(2, 10), project(1, 10)], []).map(p => p.id)).toEqual([2, 1])
  })

  it('searches Projects with trimmed, case-insensitive substring matching', () => {
    const projects = [project(1, 10), { ...project(2, 20), name: 'Design System' }]
    expect(searchProjects(projects, '  DESIGN ')).toEqual([projects[1]])
    expect(searchProjects(projects, ' ')).toEqual(projects)
  })

  it('scopes conversation search when a Project id is supplied', () => {
    const conversations = [conversation(1, 7, 30, 'Design notes'), conversation(2, null, 20, 'Design question')]
    expect(searchConversations(conversations, 'design', 7).map(s => s.id)).toEqual([1])
    expect(searchConversations(conversations, 'design').map(s => s.id)).toEqual([1, 2])
    expect(searchConversations(conversations, 'design', null).map(s => s.id)).toEqual([2])
  })

})
