import { describe, expect, it } from 'vitest'
import { buildConversationGraph, structureKey, NODE_HEIGHT, NODE_WIDTH } from '@/client/components/conversation-map'
import type { Message } from '@/shared/models'

const msg = (id: number, parent_id: number | null, over: Partial<Message> = {}): Message => ({
  id, conversation_id: 1, parent_id, seq: id, role: id % 2 ? 'user' : 'assistant',
  parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, ...over,
})

/** 1 ─ 2 ─ 4      a fork under 1, and a deeper one under 2
 *    └ 3      */
const tree = new Map<number, Message>([
  [1, msg(1, null)], [2, msg(2, 1)], [3, msg(3, 1)], [4, msg(4, 2)],
])

describe('conversation map structure key', () => {
  it('ignores content, status and usage', () => {
    const before = structureKey(tree)
    const touched = new Map(tree)
    touched.set(2, msg(2, 1, {
      parts: [{ type: 'text', text: 'streamed token' }],
      status: 'streaming',
      usage: { prompt: 5, completion: 5 },
    }))
    expect(structureKey(touched)).toBe(before)
  })

  it('changes when the tree gains, loses or re-parents a message', () => {
    const before = structureKey(tree)
    const added = new Map(tree)
    added.set(5, msg(5, 4))
    expect(structureKey(added)).not.toBe(before)

    const removed = new Map(tree)
    removed.delete(4)
    expect(structureKey(removed)).not.toBe(before)

    const reparented = new Map(tree)
    reparented.set(4, msg(4, 3))
    expect(structureKey(reparented)).not.toBe(before)
  })
})

describe('conversation map graph', () => {
  it('carries only the message id into node data', () => {
    const graph = buildConversationGraph(tree, [1, 2, 4])
    expect(graph.nodes.map(node => node.data)).toEqual([
      { messageId: 1, active: true }, { messageId: 2, active: true },
      { messageId: 3, active: false }, { messageId: 4, active: true },
    ])
  })

  it('links every child to its parent and marks edges on the active path', () => {
    const graph = buildConversationGraph(tree, [1, 2, 4])
    expect(graph.edges.map(edge => [edge.source, edge.target, edge.data?.active])).toEqual([
      ['2', '1', true], ['3', '1', false], ['4', '2', true],
    ].map(([source, target, active]) => [target, source, active]))
  })

  it('lays parents above children and keeps siblings apart', () => {
    const graph = buildConversationGraph(tree, [])
    const at = (id: number) => graph.nodes.find(node => node.id === String(id))!.position
    expect(at(2).y).toBeGreaterThan(at(1).y)
    expect(at(4).y).toBeGreaterThan(at(2).y)
    expect(Math.abs(at(2).x - at(3).x)).toBeGreaterThanOrEqual(NODE_WIDTH)
    expect(at(2).y - at(1).y).toBeGreaterThanOrEqual(NODE_HEIGHT)
  })

  it('survives a message whose parent is missing', () => {
    const orphaned = new Map([[9, msg(9, 404)]])
    const graph = buildConversationGraph(orphaned, [])
    expect(graph.nodes.map(node => node.id)).toEqual(['9'])
    expect(graph.edges).toEqual([])
  })

  it('returns nothing for an empty conversation', () => {
    expect(buildConversationGraph(new Map(), [])).toEqual({ nodes: [], edges: [] })
  })
})
