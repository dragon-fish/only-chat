import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'

/** Walks parent links from `headId` up to the root and returns the path root-first. */
export function pathToRoot(byId: ReadonlyMap<number, Message>, headId: number | null): Message[] {
  const out: Message[] = []
  let cur = headId === null ? undefined : byId.get(headId)
  const seen = new Set<number>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.push(cur)
    cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id)
  }
  return out.reverse()
}

/** All messages sharing `message`'s parent (including itself), ordered by seq. */
export function siblingsOf(all: readonly Message[], message: Message): Message[] {
  return all.filter((m) => m.parent_id === message.parent_id).sort((a, b) => a.seq - b.seq)
}

export function titleFromParts(parts: Part[]): string {
  const text = parts.find((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')?.text.trim() ?? ''
  return text.length > 0 ? text.slice(0, 40) : '新对话'
}
