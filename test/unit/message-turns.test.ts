import { expect, it } from 'vitest'
import { messageTurns, plainText } from '@/client/lib/message-turns'
import type { Message } from '@/shared/models'

const message = (id: number, role: Message['role'], parts: Message['parts']): Message => ({
  id, conversation_id: 1, parent_id: null, seq: id, role, parts, provider_id: null, model_id: null,
  usage: null, status: 'done', error: null, created_at: 0,
})

it('starts a turn at each prompt and gathers every reply message until the next one', () => {
  expect(messageTurns([
    message(1, 'user', [{ type: 'text', text: 'first' }]),
    message(2, 'assistant', [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'calling' }]),
    message(3, 'assistant', [{ type: 'text', text: 'done' }]),
    message(4, 'user', [{ type: 'image', attachment_id: 9 }]),
  ])).toEqual([
    { id: 1, prompt: 'first', reply: 'calling done' },
    { id: 4, prompt: '[图片]', reply: '' },
  ])
})

it('ignores reply text that precedes any prompt', () => {
  expect(messageTurns([message(1, 'assistant', [{ type: 'text', text: 'orphan' }])])).toEqual([])
})

it('flattens markdown to a readable line', () => {
  expect(plainText('# Title\n\n- **bold** and [link](https://x.test)\n```js\ncode\n```\n> quote')).toBe('Title bold and link quote')
})
