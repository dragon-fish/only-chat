/**
 * One file as the human file panel shows it. Addressed by row id rather than by path, because the
 * panel acts on a file it is already looking at, and a path could have been reused since it loaded.
 */
export interface FileRecord {
  id: number
  path: string
  relativePath: string
  fileSize: number
  totalLines: number
  version: number
  updatedAt: number
  createdAt: number
  /** Where the newest version came from, when it came from a conversation. */
  sourceConversationId: number | null
  sourceMessageId: number | null
}
