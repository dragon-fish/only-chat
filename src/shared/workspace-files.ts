/**
 * Mounts. Models cannot create, rename or delete them. The memory mounts sit one level down, under
 * a `/memory` directory that holds nothing else; the string is also what `workspace_files.mount`
 * stores, so a stored row and a parsed path never need translating into each other.
 */
export const WORKSPACE_MOUNTS = ['project', 'conversation', 'memory/user', 'memory/project'] as const
export type WorkspaceMount = (typeof WORKSPACE_MOUNTS)[number]

/**
 * One file as the human file panel shows it. Addressed by row id rather than by path, because the
 * panel acts on a file it is already looking at, and a path could have been reused since it loaded.
 */
export interface FileRecord {
  id: number
  path: string
  relativePath: string
  mount: WorkspaceMount
  /** Which Project or conversation holds it; see `workspace_files` for which mount sets which. */
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
