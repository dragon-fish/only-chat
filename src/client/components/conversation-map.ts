import dagre from '@dagrejs/dagre'
import type { Message } from '@/shared/models'

/**
 * Cards are a fixed size so dagre never has to measure the DOM and the layout does not shift while
 * a reply streams into a node.
 */
export const NODE_WIDTH = 240
export const NODE_HEIGHT = 96

export interface MapNodeData {
  /**
   * Only the id travels into the graph — never the message itself.
   *
   * A streaming reply mutates its message on every token. If the content lived here, each token
   * would change the node data, and the whole graph would be laid out again. The card component
   * reads the message from the store by this id instead, so a token repaints one card and the
   * layout never runs.
   */
  messageId: number
  /** On the conversation's current path: drawn in full colour, versus a dimmed inactive branch. */
  active: boolean
}

export interface MapNode {
  id: string
  type: 'message'
  position: { x: number, y: number }
  data: MapNodeData
}

export interface MapEdge {
  id: string
  source: string
  target: string
  data: { active: boolean }
}

export interface ConversationGraph {
  nodes: MapNode[]
  edges: MapEdge[]
}

/**
 * Identifies the shape of the tree, and nothing else.
 *
 * Deliberately built from ids, parents and order only: content, status and usage all change while a
 * reply streams, and including any of them would make the layout re-run on every token. Callers
 * memoise the layout on this key.
 */
export function structureKey(messages: ReadonlyMap<number, Message>): string {
  return [...messages.values()]
    .map(message => `${message.id}:${message.parent_id ?? ''}:${message.seq}`)
    .sort()
    .join('|')
}

export function buildConversationGraph(
  messages: ReadonlyMap<number, Message>,
  activePath: readonly number[],
): ConversationGraph {
  if (messages.size === 0) return { nodes: [], edges: [] }
  const active = new Set(activePath)
  const ordered = [...messages.values()].sort((a, b) => a.seq - b.seq || a.id - b.id)

  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 48, marginx: 24, marginy: 24 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const message of ordered) graph.setNode(String(message.id), { width: NODE_WIDTH, height: NODE_HEIGHT })

  const edges: MapEdge[] = []
  for (const message of ordered) {
    // A parent outside the map (an unloaded ancestor) leaves the child as its own root rather than
    // pointing an edge at a node that does not exist.
    if (message.parent_id === null || !messages.has(message.parent_id)) continue
    const source = String(message.parent_id)
    const target = String(message.id)
    graph.setEdge(source, target)
    edges.push({
      id: `${source}->${target}`,
      source,
      target,
      data: { active: active.has(message.parent_id) && active.has(message.id) },
    })
  }

  dagre.layout(graph)

  const nodes = ordered.map((message): MapNode => {
    // dagre positions a node by its centre; Vue Flow places it by its top-left corner.
    const { x, y } = graph.node(String(message.id)) as { x: number, y: number }
    return {
      id: String(message.id),
      type: 'message',
      position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
      data: { messageId: message.id, active: active.has(message.id) },
    }
  })

  return { nodes, edges }
}
