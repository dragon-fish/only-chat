import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { isTextMime } from '@/shared/file-media'

/**
 * Token estimates for deciding when to compact (spec §3.2). Deliberately crude and on the high side:
 * an estimate only ever decides whether to act, it never promises that something fits.
 */

/** What one image costs, whatever its size. */
export const IMAGE_TOKENS = 1600
/**
 * A non-text, non-image attachment (PDF, audio, video) whose textual size is unknown. Conservative:
 * a PDF page is one to two thousand tokens, and over-estimating only compacts a little early.
 */
export const OTHER_ATTACHMENT_TOKENS = 8000
/** Role markers and framing every message carries on the wire. */
export const MESSAGE_OVERHEAD_TOKENS = 4

/** What the estimates and the attachment markers need to know of a stored attachment. */
export interface AttachmentInfo {
  /** The `asset:` prefix the file is named by (`ASSET_REF_LENGTH` hex digits of its sha256). */
  prefix: string
  mime: string
  size: number
}
export type AttachmentInfos = ReadonlyMap<number, AttachmentInfo>

const encoder = new TextEncoder()

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength
}

/** UTF-8 bytes ÷ 3: close for English, generous for CJK, which is what a trigger wants. */
export function textTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / 3)
}

export function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

export function attachmentTokens(id: number, infos: AttachmentInfos, image = false): number {
  const info = infos.get(id)
  if (!info) return image ? IMAGE_TOKENS : OTHER_ATTACHMENT_TOKENS
  if (image || info.mime.startsWith('image/')) return IMAGE_TOKENS
  if (isTextMime(info.mime)) return Math.ceil(info.size / 3)
  return OTHER_ATTACHMENT_TOKENS
}

export function attachmentsTokens(ids: readonly number[], infos: AttachmentInfos): number {
  return ids.reduce((sum, id) => sum + attachmentTokens(id, infos), 0)
}

/** A tool result's text, without the files it delivered. */
export function toolResultTextTokens(part: Extract<Part, { type: 'tool_result' }>): number {
  return textTokens(part.name) + textTokens(stringify(part.content))
}

export function partTokens(part: Part, infos: AttachmentInfos): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return textTokens(part.text)
    case 'image':
      return attachmentTokens(part.attachment_id, infos, true)
    case 'file':
      return attachmentTokens(part.attachment_id, infos)
    case 'tool_call':
      return textTokens(part.name) + textTokens(stringify(part.args))
    case 'tool_result':
      return toolResultTextTokens(part) + attachmentsTokens(part.attachments ?? [], infos)
    case 'task_notification':
      return textTokens(part.text) + attachmentsTokens(part.attachments ?? [], infos)
    case 'checkpoint':
      return textTokens(part.content) + attachmentsTokens(part.attachments, infos)
  }
}

export function messageTokens(message: Pick<Message, 'parts' | 'notes'>, infos: AttachmentInfos): number {
  let total = MESSAGE_OVERHEAD_TOKENS
  for (const part of message.parts) total += partTokens(part, infos)
  for (const note of message.notes ?? []) total += textTokens(note.text)
  return total
}

export function messagesTokens(messages: readonly Pick<Message, 'parts' | 'notes'>[], infos: AttachmentInfos): number {
  return messages.reduce((sum, message) => sum + messageTokens(message, infos), 0)
}

/** Every attachment id the messages carry, for loading their sizes in one go. */
export function attachmentIdsOf(messages: readonly Pick<Message, 'parts'>[]): number[] {
  const ids = new Set<number>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'image' || part.type === 'file') ids.add(part.attachment_id)
      else if (part.type === 'tool_result' || part.type === 'task_notification') for (const id of part.attachments ?? []) ids.add(id)
      else if (part.type === 'checkpoint') for (const id of part.attachments) ids.add(id)
    }
  }
  return [...ids]
}
