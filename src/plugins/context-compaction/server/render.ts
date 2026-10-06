import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { stringify, textTokens, utf8Bytes, type AttachmentInfos } from './estimate'

/**
 * Messages as plain text (spec §3.4, §3.6): one entry per part, reasoning dropped, files as markers.
 * The recent transcript and the flattened summary input are both cut from these entries.
 */

/** Recent transcript budget when the model's window is unknown. */
export const DEFAULT_TRANSCRIPT_TOKENS = 4000
/** Share of the context window the recent transcript may take. */
const TRANSCRIPT_SHARE = 0.02
/** Below this much room, an oversized entry is left out rather than cut down to a stub. */
const MIN_EXCERPT_TOKENS = 64

export function transcriptBudget(contextLimit: number | null): number {
  return contextLimit === null ? DEFAULT_TRANSCRIPT_TOKENS : Math.floor(contextLimit * TRANSCRIPT_SHARE)
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** How a file reads in text: `[image asset:ab12cd34]`, the way the file reader names it to the model. */
export function attachmentMarker(id: number, infos: AttachmentInfos, kind: 'image' | 'file' | 'generated image', filename?: string): string {
  const info = infos.get(id)
  const name = filename ? ` ${JSON.stringify(filename)}` : ''
  if (!info) return `[${kind}${name}]`
  const mime = kind === 'file' ? ` ${info.mime}` : ''
  return `[${kind} asset:${info.prefix}${name}${mime}]`
}

function partEntry(part: Part, role: Message['role'], infos: AttachmentInfos): string | null {
  const speaker = role === 'user' ? '[User]' : '[Assistant]'
  switch (part.type) {
    case 'text':
      return part.text.trim().length === 0 ? null : `${speaker}: ${part.text}`
    case 'reasoning':
    case 'checkpoint':
      return null
    case 'image':
      return `${speaker}: ${attachmentMarker(part.attachment_id, infos, role === 'user' ? 'image' : 'generated image', part.filename)}`
    case 'file':
      return `${speaker}: ${attachmentMarker(part.attachment_id, infos, 'file', part.filename)}`
    case 'tool_call':
      return `[Tool call] ${part.name}(${stringify(part.args ?? {})})`
    case 'tool_result': {
      const files = (part.attachments ?? []).map(id => ` ${attachmentMarker(id, infos, 'file')}`).join('')
      return `[Tool result] ${part.name}${part.is_error ? ' (error)' : ''}: ${stringify(part.content)}${files}`
    }
    case 'task_notification': {
      const files = (part.attachments ?? []).map(id => ` ${attachmentMarker(id, infos, 'file')}`).join('')
      return `[Task notification] ${part.status}: ${part.text}${files}`
    }
  }
}

/** Oldest first. */
export function messageEntries(messages: readonly Message[], infos: AttachmentInfos): string[] {
  const entries: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      const entry = partEntry(part, message.role, infos)
      if (entry !== null) entries.push(entry)
    }
  }
  return entries
}

/** The longest prefix of `text` within `bytes` UTF-8 bytes, never splitting a character. */
function headWithin(text: string, bytes: number): string {
  let used = 0
  let end = 0
  for (const char of text) {
    const size = utf8Bytes(char)
    if (used + size > bytes) break
    used += size
    end += char.length
  }
  return text.slice(0, end)
}

function tailWithin(text: string, bytes: number): string {
  const chars = [...text]
  let used = 0
  let start = chars.length
  while (start > 0) {
    const size = utf8Bytes(chars[start - 1]!)
    if (used + size > bytes) break
    used += size
    start--
  }
  return chars.slice(start).join('')
}

/**
 * `text` cut to `tokens`, keeping its beginning and end around an omission marker. `escape` runs on
 * the kept text and is counted against the budget, since escaping lengthens it.
 */
export function truncateMiddle(text: string, tokens: number, escape: (text: string) => string = t => t): string {
  const whole = escape(text)
  if (textTokens(whole) <= tokens) return whole
  let bytes = tokens * 3
  for (let attempt = 0; attempt < 8 && bytes > 0; attempt++) {
    const marker = `\n[… ${utf8Bytes(text)} bytes, middle omitted …]\n`
    const room = Math.max(0, bytes - utf8Bytes(marker))
    const head = headWithin(text, Math.ceil(room / 2))
    const tail = tailWithin(text.slice(head.length), Math.floor(room / 2))
    const cut = `${escape(head)}${marker}${escape(tail)}`
    if (textTokens(cut) <= tokens) return cut
    bytes = Math.floor(bytes * 0.85)
  }
  return ''
}

/**
 * The verbatim excerpt that ends the checkpoint (spec §3.6): whole entries from the newest back while
 * they fit, the one that does not cut to its head and tail, nothing before it. Never over `budget`.
 */
export function recentTranscript(messages: readonly Message[], infos: AttachmentInfos, budget: number): string {
  const entries = messageEntries(messages, infos)
  const kept: string[] = []
  let left = budget
  for (let index = entries.length - 1; index >= 0; index--) {
    const escaped = escapeXml(entries[index]!)
    // The newline joining entries costs a byte; one token per entry covers it.
    const cost = textTokens(escaped) + 1
    if (cost <= left) {
      kept.unshift(escaped)
      left -= cost
      continue
    }
    if (left - 1 >= MIN_EXCERPT_TOKENS) {
      const cut = truncateMiddle(entries[index]!, left - 1, escapeXml)
      if (cut) kept.unshift(cut)
    }
    break
  }
  return kept.join('\n')
}

/** The flattened input's own default when the fallback model's window is unknown (spec §3.4). */
export const DEFAULT_FLATTEN_CONTEXT = 100_000
/** One entry may take at most this share of the flattened budget, so one huge tool result cannot crowd out the rest. */
const FLATTEN_ENTRY_SHARE = 0.25

/**
 * The conversation as one text for the compaction fallback model (spec §3.4): the current checkpoint's
 * content first, then the visible messages, cut from the oldest with one line saying so.
 */
export function flattenConversation(previous: string | null, messages: readonly Message[], infos: AttachmentInfos, budget: number): string {
  const head = previous ? `${previous}\n\n` : ''
  let left = budget - textTokens(head)
  const entries = messageEntries(messages, infos)
  const entryCap = Math.max(MIN_EXCERPT_TOKENS, Math.floor(budget * FLATTEN_ENTRY_SHARE))
  const kept: string[] = []
  let index = entries.length - 1
  for (; index >= 0; index--) {
    const entry = truncateMiddle(entries[index]!, entryCap)
    const cost = textTokens(entry) + 1
    if (cost > left) break
    kept.unshift(entry)
    left -= cost
  }
  const omitted = index + 1
  const notice = omitted > 0 ? `[… ${omitted} earlier ${omitted === 1 ? 'entry' : 'entries'} omitted …]\n` : ''
  return `${head}${notice}${kept.join('\n')}`
}
