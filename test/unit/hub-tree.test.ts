import { describe, expect, it } from 'vitest'
import { pathToRoot, siblingsOf, titleFromParts } from '@/server/plugins/hub/tree'
import type { Message } from '@/shared/models'

function m(id: number, parent_id: number | null, seq = id): Message {
  return { id, conversation_id: 1, parent_id, seq, role: id % 2 ? 'user' : 'assistant', parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0 }
}
// 1 → 2 → 3 ; 1 → 4 (sibling of 2) ; 4 → 5
const all = [m(1, null), m(2, 1), m(3, 2), m(4, 1), m(5, 4)]
const byId = new Map(all.map((x) => [x.id, x]))

describe('tree', () => {
  it('walks head to root and returns root-first', () => {
    expect(pathToRoot(byId, 5).map((x) => x.id)).toEqual([1, 4, 5])
    expect(pathToRoot(byId, 3).map((x) => x.id)).toEqual([1, 2, 3])
  })
  it('returns empty for null head', () => {
    expect(pathToRoot(byId, null)).toEqual([])
  })
  it('lists siblings sorted by seq including self', () => {
    expect(siblingsOf(all, byId.get(4)!).map((x) => x.id)).toEqual([2, 4])
    expect(siblingsOf(all, byId.get(1)!).map((x) => x.id)).toEqual([1])
  })
  it('derives a title from the first text part', () => {
    expect(titleFromParts([{ type: 'image', attachment_id: 1 }, { type: 'text', text: '  Hello world  ' }])).toBe('Hello world')
    expect(titleFromParts([{ type: 'text', text: 'x'.repeat(100) }])).toHaveLength(40)
    expect(titleFromParts([{ type: 'image', attachment_id: 1 }])).toBe('新对话')
  })
})
