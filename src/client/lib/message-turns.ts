import type { Message } from '@/shared/models'

/** One exchange: a prompt and whatever came back before the next prompt. */
export interface MessageTurn {
  /** The user message's id — also its anchor id in MessageScroller. */
  id: number
  prompt: string
  reply: string
}

const text = (message: Message) => message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')

/**
 * Markdown to one line of readable text, for previews only. Deliberately rough: it drops the marks
 * a reader would see as noise and never tries to render anything.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The turns along one branch path, in order. Only prompts start a turn: a reply split across several
 * assistant messages (a tool round trip) still reads as one answer, and text before the first prompt
 * belongs to no turn.
 */
export function messageTurns(path: readonly Message[]): MessageTurn[] {
  const turns: MessageTurn[] = []
  const replies: string[][] = []
  for (const message of path) {
    if (message.role === 'user') {
      const prompt = plainText(text(message))
      turns.push({ id: message.id, prompt: prompt || (message.parts.some(part => part.type === 'image') ? '[图片]' : ''), reply: '' })
      replies.push([])
    } else if (message.role === 'assistant' && replies.length) {
      replies.at(-1)!.push(text(message))
    }
  }
  return turns.map((turn, index) => ({ ...turn, reply: plainText(replies[index]!.join('\n')) }))
}
