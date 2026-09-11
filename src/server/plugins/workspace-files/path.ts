/**
 * Path parsing for the workspace filesystem.
 *
 * Kept separate from the service and free of I/O: this is the layer that decides what a model is
 * allowed to name, so it must be exhaustively testable on its own. Resolution is strict rather than
 * forgiving — a path is either exactly one canonical form or it is rejected. Normalising `//` or
 * `..` away would mean two different strings addressing one file, and the uniqueness index would
 * then be enforcing something other than what the model sees.
 */

/** Top-level mounts. Models cannot create, rename or delete them. */
export const WORKSPACE_MOUNTS = ['project', 'conversation'] as const
export type WorkspaceMount = (typeof WORKSPACE_MOUNTS)[number]

/** Comfortably below D1's limits while leaving no doubt about where the boundary is. */
export const MAX_RELATIVE_PATH_LENGTH = 512

export interface WorkspacePath {
  /** `null` only for `/`, which lists the mounts themselves. */
  mount: WorkspaceMount | null
  /** Empty when the path names a mount root. Never starts or ends with a separator. */
  relativePath: string
}

export type ParseResult =
  | { ok: true, value: WorkspacePath }
  | { ok: false, error: 'INVALID_PATH' }

const INVALID = { ok: false, error: 'INVALID_PATH' } as const

/**
 * Printable ASCII minus the separator, plus anything above it. Excluding control characters takes
 * NUL bytes with it, and excluding a leading or trailing space keeps two visually identical names
 * from coexisting.
 */
function isValidSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false
  if (segment !== segment.trim()) return false
  // Control characters (NUL included) and whitespace are both excluded: either would let two
  // names look identical on screen while differing in storage.
  if (/[\x00-\x1f\x7f]/.test(segment)) return false
  return !/\s/.test(segment)
}

export function parseWorkspacePath(input: string): ParseResult {
  if (typeof input !== 'string' || !input.startsWith('/')) return INVALID
  if (input === '/') return { ok: true, value: { mount: null, relativePath: '' } }

  // One trailing slash names a directory and is dropped; anything else is a malformed path.
  const trimmed = input.endsWith('/') ? input.slice(0, -1) : input
  if (trimmed.endsWith('/')) return INVALID

  const segments = trimmed.slice(1).split('/')
  const [mount, ...rest] = segments
  if (!WORKSPACE_MOUNTS.includes(mount as WorkspaceMount)) return INVALID

  // A file path may not end in a separator; only a mount root may be named with one.
  if (input.endsWith('/') && rest.length > 0) return INVALID

  for (const segment of rest) if (!isValidSegment(segment)) return INVALID

  const relativePath = rest.join('/')
  if (relativePath.length > MAX_RELATIVE_PATH_LENGTH) return INVALID
  return { ok: true, value: { mount: mount as WorkspaceMount, relativePath } }
}

/** Renders a parsed path back to its canonical absolute form. */
export function formatWorkspacePath(path: WorkspacePath): string {
  if (path.mount === null) return '/'
  return path.relativePath === '' ? `/${path.mount}` : `/${path.mount}/${path.relativePath}`
}

/**
 * The number of lines `offset`/`limit` can address.
 *
 * A plain split with nothing discarded: a trailing newline yields a real final empty line, which is
 * what an editor shows and what `lines.join('\n')` needs to reproduce the bytes. Measured against
 * Claude Code's own Read tool rather than assumed — it diverges from `wc -l` on purpose.
 */
export function countLines(content: string): number {
  return content === '' ? 0 : content.split('\n').length
}
