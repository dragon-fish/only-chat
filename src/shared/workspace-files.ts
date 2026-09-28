/**
 * One file as the human file panel shows it. Addressed by row id rather than by path, because the
 * panel acts on a file it is already looking at, and a path could have been reused since it loaded.
 */
export interface FileRecord {
  id: number
  path: string
  relativePath: string
  /** Where it lives. Exactly one is set, which is also what its mount is. */
  projectId: number | null
  conversationId: number | null
  fileSize: number
  /** 0 for a binary file, which has no lines to address. */
  totalLines: number
  /** The current version's type. Anything but `text/*` is binary: read by delivery, never as text. */
  mime: string
  version: number
  updatedAt: number
  createdAt: number
  /** Where the newest version came from, when it came from a conversation. */
  sourceConversationId: number | null
  sourceMessageId: number | null
}
