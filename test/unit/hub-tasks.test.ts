import { describe, expect, it } from 'vitest'
import { awaitsHuman, deliveredTaskIds, notificationTurnsSinceHuman, originOnPath } from '@/server/plugins/hub/tasks'
import type { Message } from '@/shared/models'
import type { Part, TaskNotificationPart } from '@/shared/parts'

const notice = (task_id: string): TaskNotificationPart => ({
  type: 'task_notification', task_id, plugin_id: 'image_generation', tool_call_id: 'c', status: 'completed', text: 'ok',
})
const msg = (id: number, role: 'user' | 'assistant', parts: Part[]): Message => ({
  id, conversation_id: 1, parent_id: id - 1 || null, seq: id, role, parts, provider_id: null, model_id: null,
  usage: null, status: 'done', error: null, created_at: 0,
})

describe('task delivery rules', () => {
  it('finds tasks already delivered anywhere in the conversation', () => {
    expect(deliveredTaskIds([msg(1, 'user', [notice('image_run:1')]), msg(2, 'assistant', [])])).toEqual(new Set(['image_run:1']))
  })

  it('delivers only while the launching message is still on the current path', () => {
    const path = [msg(1, 'user', [{ type: 'text', text: 'draw' }]), msg(2, 'assistant', [])]
    expect(originOnPath(path, 2)).toBe(true)
    expect(originOnPath(path, 7)).toBe(false)
  })

  it('counts notification-only turns since the person last wrote', () => {
    const path = [
      msg(1, 'user', [{ type: 'text', text: 'draw' }]), msg(2, 'assistant', []),
      msg(3, 'user', [notice('a')]), msg(4, 'assistant', []),
      msg(5, 'user', [notice('b')]), msg(6, 'assistant', []),
    ]
    expect(notificationTurnsSinceHuman(path)).toBe(2)
    expect(notificationTurnsSinceHuman([...path, msg(7, 'user', [notice('c'), { type: 'text', text: 'hi' }])])).toBe(0)
  })

  it('holds delivery while a question to the person is unanswered', () => {
    const isHuman = (name: string) => name === 'ask_user'
    expect(awaitsHuman(msg(2, 'assistant', [{ type: 'tool_call', id: 'q', name: 'ask_user', args: {} }]), isHuman)).toBe(true)
    expect(awaitsHuman(msg(2, 'assistant', [
      { type: 'tool_call', id: 'q', name: 'ask_user', args: {} },
      { type: 'tool_result', call_id: 'q', name: 'ask_user', content: {} },
    ]), isHuman)).toBe(false)
    expect(awaitsHuman(msg(2, 'assistant', [{ type: 'tool_call', id: 's', name: 'web_search', args: {} }]), isHuman)).toBe(false)
  })
})
