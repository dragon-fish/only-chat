import { describe, expect, it } from 'vitest'
import { memoryScopes } from '@/plugins/memory/shared'

describe('memoryScopes', () => {
  it('opens both layers by default inside a Project, and only user memory outside one', () => {
    expect(memoryScopes({ config: undefined, project: {}, conversation: undefined })).toEqual({ user: true, project: true })
    expect(memoryScopes({ config: undefined, project: null, conversation: undefined })).toEqual({ user: true, project: false })
  })

  it('closes user memory when any level above the conversation says so', () => {
    expect(memoryScopes({ config: { user_memory: false }, project: {}, conversation: {} }).user).toBe(false)
    expect(memoryScopes({ config: {}, project: { use_user_memory: false }, conversation: {} }).user).toBe(false)
    expect(memoryScopes({ config: {}, project: {}, conversation: { user_memory: false } }).user).toBe(false)
  })

  it('ignores a Project\'s switches for a conversation outside it', () => {
    expect(memoryScopes({ config: {}, project: null, conversation: { project_memory: false } })).toEqual({ user: true, project: false })
  })

  it('closes project memory from the Project or the conversation, leaving user memory alone', () => {
    expect(memoryScopes({ config: {}, project: { project_memory: false }, conversation: {} })).toEqual({ user: true, project: false })
    expect(memoryScopes({ config: {}, project: {}, conversation: { project_memory: false } })).toEqual({ user: true, project: false })
  })
})
