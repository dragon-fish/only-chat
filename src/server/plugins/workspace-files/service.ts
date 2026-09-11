import { and, asc, eq, isNull, like, sql } from 'drizzle-orm'
import type { DB } from '../../db/client'
import { attachments, workspaceFileVersions, workspaceFiles } from '../../db/schema'
import { r2Key } from '../api/attachments'
import { countLines, formatWorkspacePath, parseWorkspacePath, WORKSPACE_MOUNTS, type WorkspaceMount } from './path'

/** Failures a model can correct on its own. Anything else throws and fails the tool call. */
export type WorkspaceError =
  | 'INVALID_PATH'
  | 'MOUNT_UNAVAILABLE'
  | 'FILE_NOT_FOUND'
  | 'FILE_ALREADY_EXISTS'
  | 'VERSION_CONFLICT'
  | 'VERSION_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'READ_RANGE_TOO_LARGE'

export type Result<T> = { ok: true, value: T } | { ok: false, error: WorkspaceError }

const fail = (error: WorkspaceError): Result<never> => ({ ok: false, error })
const succeed = <T>(value: T): Result<T> => ({ ok: true, value })

export const MAX_FILE_BYTES = 1024 * 1024
export const DEFAULT_READ_LINES = 2000
export const MAX_RESULT_BYTES = 100 * 1024
const MIME = 'text/markdown; charset=utf-8'

/**
 * Only what the filesystem needs from object storage.
 *
 * Structural rather than the `Assets` service itself, so the rules can be tested against an
 * in-memory store without standing up a Cordis context.
 */
export interface WorkspaceStorage {
  put(key: string, bytes: Uint8Array | ArrayBuffer, mime: string): Promise<void>
  getBytes(key: string): Promise<{ bytes: Uint8Array } | null>
}

/** Which Conversation and Project the caller is inside. Never supplied by tool input. */
export interface WorkspaceScope {
  conversationId: number
  projectId: number | null
}

export interface WriteInput extends WorkspaceScope {
  path: string
  content: string
  expectedVersion?: number
  sourceMessageId?: number | null
  toolCallId?: string | null
}

export interface WriteResult {
  path: string
  /** `replaced` means a version was displaced without the caller naming it; it remains restorable. */
  operation: 'created' | 'updated' | 'replaced'
  fileSize: number
  totalLines: number
  version: number
  /** The version this write displaced, or `null` when nothing was displaced. */
  replacedVersion: number | null
  updatedAt: number
}

export interface RestoreInput extends WorkspaceScope {
  path: string
  version: number
  /** Must not exist. Restoring may never destroy anything. */
  toPath: string
  sourceMessageId?: number | null
  toolCallId?: string | null
}

export interface RestoreResult {
  path: string
  sourcePath: string
  restoredFrom: number
  version: number
  fileSize: number
  totalLines: number
  updatedAt: number
}

export interface ReadInput extends WorkspaceScope {
  path: string
  offset?: number
  limit?: number
}

export interface ReadResult {
  path: string
  content: string
  startLine: number
  returnedLines: number
  totalLines: number
  fileSize: number
  updatedAt: number
  version: number
  truncated: boolean
  nextOffset: number | null
  /** Distinguishes an empty file from one holding a single newline. */
  empty: boolean
}

export interface ListEntry {
  path: string
  type: 'mount' | 'directory' | 'file'
  status?: 'empty' | 'ready' | 'unavailable'
  fileSize?: number
  totalLines?: number
  updatedAt?: number
  version?: number
}

export interface ListResult {
  path: string
  entries: ListEntry[]
  truncated: boolean
  nextCursor: string | null
}

/**
 * Owns every rule of the workspace filesystem: path resolution, scope authorization, version
 * control and content publication.
 *
 * Tools and HTTP routes go through this class rather than touching D1 or R2, so a future sandbox,
 * import or generator can publish a version without re-deriving any of it.
 */
export class WorkspaceFiles {
  constructor(
    private readonly db: DB,
    private readonly storage: WorkspaceStorage,
    private readonly userId: number,
  ) {}

  /** Resolves a mount to the row scope it addresses, or reports why it cannot be used. */
  private scopeOf(mount: WorkspaceMount, scope: WorkspaceScope): Result<{ projectId: number | null, conversationId: number | null }> {
    if (mount === 'conversation') return succeed({ projectId: null, conversationId: scope.conversationId })
    // A Conversation outside any Project has nowhere to put shared files. That is a state the model
    // should see and work around, not an error.
    if (scope.projectId === null) return fail('MOUNT_UNAVAILABLE')
    return succeed({ projectId: scope.projectId, conversationId: null })
  }

  private whereScope(target: { projectId: number | null, conversationId: number | null }) {
    return target.projectId === null
      ? eq(workspaceFiles.conversation_id, target.conversationId!)
      : eq(workspaceFiles.project_id, target.projectId)
  }

  private async findFile(target: { projectId: number | null, conversationId: number | null }, relativePath: string) {
    const [row] = await this.db.select().from(workspaceFiles).where(and(
      eq(workspaceFiles.user_id, this.userId),
      this.whereScope(target),
      eq(workspaceFiles.relative_path, relativePath),
      isNull(workspaceFiles.deleted_at),
    )).limit(1)
    return row
  }

  /**
   * Stores bytes as a user-scoped attachment, reusing an identical one.
   *
   * Deduplication is per user, so identical content in two conversations is one object while two
   * users never share a row.
   */
  private async publishBytes(content: string): Promise<number> {
    const bytes = new TextEncoder().encode(content)
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')

    const [existing] = await this.db.select().from(attachments)
      .where(and(eq(attachments.user_id, this.userId), eq(attachments.sha256, sha256))).limit(1)
    if (existing) return existing.id

    const key = r2Key(this.userId, sha256)
    await this.storage.put(key, bytes, MIME)
    try {
      const [row] = await this.db.insert(attachments).values({
        user_id: this.userId, sha256, mime: MIME, size: bytes.byteLength,
        width: null, height: null, r2_key: key, origin: 'generated', created_at: Date.now(),
      }).returning()
      if (!row) throw new Error('attachment insert returned no row')
      return row.id
    } catch (error) {
      // A concurrent write of the same bytes may have taken the unique index. That row owns this
      // key — identical digest, identical object — so the object stays.
      const [owner] = await this.db.select().from(attachments)
        .where(and(eq(attachments.user_id, this.userId), eq(attachments.sha256, sha256))).limit(1)
      if (owner) return owner.id
      throw error
    }
  }

  async write(input: WriteInput): Promise<Result<WriteResult>> {
    const parsed = parseWorkspacePath(input.path)
    if (!parsed.ok) return fail('INVALID_PATH')
    const { mount, relativePath } = parsed.value
    // A mount is a directory; only a path below one names a file.
    if (mount === null || relativePath === '') return fail('INVALID_PATH')

    const scope = this.scopeOf(mount, input)
    if (!scope.ok) return scope
    const target = scope.value

    const bytes = new TextEncoder().encode(input.content)
    if (bytes.byteLength > MAX_FILE_BYTES) return fail('FILE_TOO_LARGE')

    const existing = await this.findFile(target, relativePath)
    if (!existing && input.expectedVersion !== undefined) return fail('FILE_NOT_FOUND')
    // Omitting the version is not an error: refusing would throw away whatever the caller spent
    // producing this content, to protect a version that stays restorable either way. Passing one is
    // a claim about the current state, and a wrong claim means someone else moved the file — that
    // is a real conflict, and overwriting it would lose their work.
    if (existing && input.expectedVersion !== undefined && input.expectedVersion !== existing.current_version) {
      return fail('VERSION_CONFLICT')
    }

    const attachmentId = await this.publishBytes(input.content)
    const now = Date.now()
    const totalLines = countLines(input.content)
    const path = formatWorkspacePath(parsed.value)

    if (!existing) {
      let fileId: number
      try {
        const [created] = await this.db.insert(workspaceFiles).values({
          user_id: this.userId, project_id: target.projectId, conversation_id: target.conversationId,
          relative_path: relativePath, current_version: 0, created_at: now, updated_at: now, deleted_at: null,
        }).returning()
        fileId = created!.id
      } catch {
        // The partial unique index rejected it: another create won the race.
        return fail('FILE_ALREADY_EXISTS')
      }
      await this.commitVersion(fileId, 0, 1, { attachmentId, bytes: bytes.byteLength, totalLines, now, input })
      return succeed({ path, operation: 'created', fileSize: bytes.byteLength, totalLines, version: 1, replacedVersion: null, updatedAt: now })
    }

    const version = existing.current_version + 1
    const moved = await this.commitVersion(existing.id, existing.current_version, version, { attachmentId, bytes: bytes.byteLength, totalLines, now, input })
    if (!moved) return fail('VERSION_CONFLICT')
    const claimed = input.expectedVersion !== undefined
    return succeed({
      path,
      operation: claimed ? 'updated' : 'replaced',
      fileSize: bytes.byteLength,
      totalLines,
      version,
      replacedVersion: claimed ? null : existing.current_version,
      updatedAt: now,
    })
  }

  /**
   * Appends the version and advances the pointer as one atomic batch.
   *
   * Order matters and so does atomicity. Inserting the version first and advancing separately leaves
   * an orphan version behind whenever the compare-and-swap loses; advancing first leaves the pointer
   * naming a version that does not exist. D1 applies a batch all-or-nothing, so neither is possible.
   */
  private async commitVersion(
    fileId: number,
    expected: number,
    version: number,
    meta: { attachmentId: number, bytes: number, totalLines: number, now: number, input: WriteInput },
  ): Promise<boolean> {
    const { attachmentId, bytes, totalLines, now, input } = meta
    const statements = [
      this.db.insert(workspaceFileVersions).values({
        file_id: fileId, version, attachment_id: attachmentId, mime: MIME, file_size: bytes, total_lines: totalLines,
        source_conversation_id: input.conversationId, source_message_id: input.sourceMessageId ?? null,
        tool_call_id: input.toolCallId ?? null, created_at: now,
      }),
      this.db.update(workspaceFiles)
        .set({ current_version: version, updated_at: now })
        .where(and(eq(workspaceFiles.id, fileId), eq(workspaceFiles.current_version, expected))),
    ] as const
    const [, update] = await this.db.batch([statements[0], statements[1]])
    const changed = (update as { meta?: { changes?: number } }).meta?.changes
    return changed === undefined || changed > 0
  }

  /**
   * Copies one stored version out under a name that is free.
   *
   * Never writes over anything: an overwrite is what restoring is meant to undo, so a taken name is
   * refused rather than resolved. The bytes already exist as an attachment, so this costs one
   * pointer row and one version row and no storage at all.
   */
  async restore(input: RestoreInput): Promise<Result<RestoreResult>> {
    const from = parseWorkspacePath(input.path)
    const to = parseWorkspacePath(input.toPath)
    if (!from.ok || !to.ok) return fail('INVALID_PATH')
    if (from.value.mount === null || from.value.relativePath === '') return fail('INVALID_PATH')
    if (to.value.mount === null || to.value.relativePath === '') return fail('INVALID_PATH')

    const fromScope = this.scopeOf(from.value.mount, input)
    if (!fromScope.ok) return fromScope
    const toScope = this.scopeOf(to.value.mount, input)
    if (!toScope.ok) return toScope

    const source = await this.findFile(fromScope.value, from.value.relativePath)
    if (!source) return fail('FILE_NOT_FOUND')

    const [version] = await this.db.select().from(workspaceFileVersions).where(and(
      eq(workspaceFileVersions.file_id, source.id),
      eq(workspaceFileVersions.version, input.version),
    )).limit(1)
    if (!version) return fail('VERSION_NOT_FOUND')

    if (await this.findFile(toScope.value, to.value.relativePath)) return fail('FILE_ALREADY_EXISTS')

    const now = Date.now()
    let fileId: number
    try {
      const [created] = await this.db.insert(workspaceFiles).values({
        user_id: this.userId, project_id: toScope.value.projectId, conversation_id: toScope.value.conversationId,
        relative_path: to.value.relativePath, current_version: 0, created_at: now, updated_at: now, deleted_at: null,
      }).returning()
      fileId = created!.id
    } catch {
      return fail('FILE_ALREADY_EXISTS')
    }

    await this.db.batch([
      this.db.insert(workspaceFileVersions).values({
        file_id: fileId, version: 1, attachment_id: version.attachment_id, mime: version.mime,
        file_size: version.file_size, total_lines: version.total_lines,
        source_conversation_id: input.conversationId, source_message_id: input.sourceMessageId ?? null,
        tool_call_id: input.toolCallId ?? null, created_at: now,
      }),
      this.db.update(workspaceFiles).set({ current_version: 1, updated_at: now }).where(eq(workspaceFiles.id, fileId)),
    ])

    return succeed({
      path: formatWorkspacePath(to.value),
      sourcePath: formatWorkspacePath(from.value),
      restoredFrom: input.version,
      version: 1,
      fileSize: version.file_size,
      totalLines: version.total_lines,
      updatedAt: now,
    })
  }

  async read(input: ReadInput): Promise<Result<ReadResult>> {
    const parsed = parseWorkspacePath(input.path)
    if (!parsed.ok) return fail('INVALID_PATH')
    const { mount, relativePath } = parsed.value
    if (mount === null || relativePath === '') return fail('INVALID_PATH')

    const scope = this.scopeOf(mount, input)
    if (!scope.ok) return scope

    const file = await this.findFile(scope.value, relativePath)
    if (!file) return fail('FILE_NOT_FOUND')

    const [version] = await this.db.select().from(workspaceFileVersions).where(and(
      eq(workspaceFileVersions.file_id, file.id),
      eq(workspaceFileVersions.version, file.current_version),
    )).limit(1)
    if (!version) return fail('FILE_NOT_FOUND')

    const [attachment] = await this.db.select().from(attachments).where(eq(attachments.id, version.attachment_id)).limit(1)
    if (!attachment) return fail('FILE_NOT_FOUND')
    const stored = await this.storage.getBytes(attachment.r2_key)
    if (!stored) return fail('FILE_NOT_FOUND')
    const content = new TextDecoder().decode(stored.bytes)

    const path = formatWorkspacePath(parsed.value)
    const base = {
      path, totalLines: version.total_lines, fileSize: version.file_size,
      updatedAt: file.updated_at, version: file.current_version,
    }
    if (content === '') {
      return succeed({ ...base, content: '', startLine: 0, returnedLines: 0, truncated: false, nextOffset: null, empty: true })
    }

    const lines = content.split('\n')
    const offset = Math.max(1, input.offset ?? 1)
    if (offset > lines.length) return fail('READ_RANGE_TOO_LARGE')
    const limit = Math.max(1, input.limit ?? DEFAULT_READ_LINES)

    const selected: string[] = []
    let usedBytes = 0
    for (let index = offset - 1; index < Math.min(lines.length, offset - 1 + limit); index++) {
      const rendered = `${index + 1} | ${lines[index]}`
      // Never silently drop content: stop at the budget and report the range that did fit.
      if (usedBytes + rendered.length > MAX_RESULT_BYTES && selected.length > 0) break
      selected.push(rendered)
      usedBytes += rendered.length + 1
    }
    if (selected.length === 0) return fail('READ_RANGE_TOO_LARGE')

    const endLine = offset + selected.length - 1
    const truncated = endLine < lines.length
    return succeed({
      ...base,
      content: selected.join('\n'),
      startLine: offset,
      returnedLines: selected.length,
      truncated,
      nextOffset: truncated ? endLine + 1 : null,
      empty: false,
    })
  }

  async list(input: WorkspaceScope & { path: string, limit?: number }): Promise<Result<ListResult>> {
    const parsed = parseWorkspacePath(input.path)
    if (!parsed.ok) return fail('INVALID_PATH')
    const { mount, relativePath } = parsed.value

    if (mount === null) {
      const entries: ListEntry[] = []
      for (const name of WORKSPACE_MOUNTS) {
        const resolved = this.scopeOf(name, input)
        if (!resolved.ok) {
          entries.push({ path: `/${name}`, type: 'mount', status: 'unavailable' })
          continue
        }
        const rows = await this.db.select({ id: workspaceFiles.id }).from(workspaceFiles)
          .where(and(eq(workspaceFiles.user_id, this.userId), this.whereScope(resolved.value), isNull(workspaceFiles.deleted_at)))
          .limit(1)
        entries.push({ path: `/${name}`, type: 'mount', status: rows.length === 0 ? 'empty' : 'ready' })
      }
      return succeed({ path: '/', entries, truncated: false, nextCursor: null })
    }

    const scope = this.scopeOf(mount, input)
    if (!scope.ok) return scope

    const prefix = relativePath === '' ? '' : `${relativePath}/`
    const rows = await this.db.select().from(workspaceFiles).where(and(
      eq(workspaceFiles.user_id, this.userId),
      this.whereScope(scope.value),
      isNull(workspaceFiles.deleted_at),
      prefix === '' ? sql`1 = 1` : like(workspaceFiles.relative_path, `${prefix}%`),
    )).orderBy(asc(workspaceFiles.relative_path))

    // Deeper paths fold into the directory that contains them; directories need no rows of their own.
    const directories = new Set<string>()
    const files: ListEntry[] = []
    for (const row of rows) {
      const rest = row.relative_path.slice(prefix.length)
      const separator = rest.indexOf('/')
      if (separator === -1) {
        files.push({
          path: `/${mount}/${row.relative_path}`, type: 'file',
          updatedAt: row.updated_at, version: row.current_version,
        })
        continue
      }
      directories.add(rest.slice(0, separator))
    }

    const limit = Math.max(1, input.limit ?? 100)
    const all: ListEntry[] = [
      ...[...directories].sort().map((name): ListEntry => ({ path: `/${mount}/${prefix}${name}`, type: 'directory' })),
      ...files,
    ]
    const entries = all.slice(0, limit)
    return succeed({
      path: formatWorkspacePath(parsed.value),
      entries,
      truncated: all.length > entries.length,
      nextCursor: null,
    })
  }
}
