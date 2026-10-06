import { describe, expect, it } from 'vitest'
import { inputAttachmentIds, turnInputsOnPath, usageFromSteps } from '@/server/plugins/hub/compaction'
import { INTERJECTED } from '@/server/plugins/llm/messages'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'

function msg(id: number, role: Message['role'], parts: Part[], over: Partial<Message> = {}): Message {
  return {
    id, conversation_id: 1, parent_id: id - 1 || null, seq: id, role, parts, provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 0, ...over,
  }
}

const say = (text: string): Part[] => [{ type: 'text', text }]
const toolStep: Part[] = [
  { type: 'tool_call', id: 'c1', name: 'echo', args: {} },
  { type: 'tool_result', call_id: 'c1', name: 'echo', content: { ok: true } },
]
const checkpoint = (id: number) => msg(id, 'assistant', [{ type: 'checkpoint', plugin: 'p', content: 'S', attachments: [], contributors: [], data: null }])
const notification: Part = {
  type: 'task_notification', task_id: 't1', plugin_id: 'p', tool_call_id: 'c9', status: 'completed', text: 'done', attachments: [42],
}

const ids = (messages: readonly Message[]) => messages.map(message => message.id)

describe('turn inputs on a path', () => {
  it('starts the turn at the last user message after a finished reply', () => {
    const path = [msg(1, 'user', say('old')), msg(2, 'assistant', say('answer')), msg(3, 'user', say('new'))]
    expect(ids(turnInputsOnPath(path))).toEqual([3])
  })

  it('reaches back across interjections and checkpoints to the message that began the turn', () => {
    const path = [
      msg(1, 'user', say('old')), msg(2, 'assistant', say('answer')),
      msg(3, 'user', say('task')), msg(4, 'assistant', toolStep, { error: INTERJECTED }),
      msg(5, 'user', say('also this')), msg(6, 'assistant', toolStep),
      checkpoint(7), msg(8, 'assistant', toolStep),
    ]
    expect(ids(turnInputsOnPath(path))).toEqual([3, 5])
  })

  it('counts a notification handed in between two steps, but not one that opened a turn of its own', () => {
    const midTurn = [msg(1, 'user', say('task')), msg(2, 'assistant', toolStep), msg(3, 'user', [notification])]
    expect(ids(turnInputsOnPath(midTurn))).toEqual([1, 3])
    const ownTurn = [msg(1, 'user', say('task')), msg(2, 'assistant', say('done')), msg(3, 'user', [notification])]
    expect(ids(turnInputsOnPath(ownTurn))).toEqual([3])
    expect(inputAttachmentIds(turnInputsOnPath(midTurn))).toEqual([42])
  })
})

describe('usage from steps', () => {
  it('sums only what was reported and keeps the steps', () => {
    expect(usageFromSteps([])).toBeNull()
    expect(usageFromSteps([{ prompt: 10, completion: 2 }, { prompt: 30, completion: 1, cached: 8 }]))
      .toEqual({ prompt: 40, completion: 3, cached: 8, steps: [{ prompt: 10, completion: 2 }, { prompt: 30, completion: 1, cached: 8 }] })
  })
})
