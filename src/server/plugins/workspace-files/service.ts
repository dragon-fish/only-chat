import type { FileRecord } from '@/shared/workspace-files'
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, lt, or, sql, type SQL } from 'drizzle-orm'
import type { DB } from '../../db/client'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import {
  artifactRunInputs, artifacts, attachments, conversations, messages, projects,
  workspaceFileVersions, workspaceFiles,
  type WorkspaceFileRow, type WorkspaceFileVersionRow,
} from '../../db/schema'
import { r2Key } from '../api/attachments'
import { countLines, formatWorkspacePath, parseWorkspacePath, WORKSPACE_MOUNTS, type WorkspaceMount } from './path'

export type { FileRecord }

/** Failures a model can correct on its own. Anything else throws and fails the tool call. */
export type WorkspaceError =
  | 'INVALID_PATH'
  | 'MOUNT_UNAVAILABLE'
  | 'FILE_NOT_FOUND'
  | 'IS_DIRECTORY'
  | 'FILE_ALREADY_EXISTS'
  | 'VERSION_CONFLICT'
  | 'VERSION_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'READ_RANGE_TOO_LARGE'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'

export type Result<T> = { ok: true, value: T } | { ok: false, error: WorkspaceError }

const fail = (error: WorkspaceError): Result<never> => ({ ok: false, error })
const succeed = <T>(value: T): Result<T> => ({ ok: true, value })

/**
 * Curly quotes straightened, one character for one.
 *
 * Length is what makes this safe to match on: an index found in the normalized text is the same
 * index in the original, so the replacement still lands on the file's own characters.
 */
function normalizeQuotes(value: string): string {
  return value.replace(/[\u2018\u2019]/gu, "'").replace(/[\u201C\u201D]/gu, '"')
}

/**
 * Where the text appears, non-overlapping, without regard to how its quotes were typed — a model
 * reproducing code from a page or from memory routinely straightens them, and refusing that costs
 * a round trip to be told the file still says what the caller just read.
 */
function matchStarts(content: string, oldText: string): number[] {
  const haystack = normalizeQuotes(content)
  const needle = normalizeQuotes(oldText)
  const starts: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) starts.push(at)
  return starts
}

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
  /** Only `purge` calls this; every other path keeps bytes addressable. */
  delete(key: string): Promise<void>
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

export interface EditInput extends WorkspaceScope {
  path: string
  oldText: string
  newText: string
  replaceAll?: boolean
  /** The version the caller computed this patch against; a mismatch is a conflict, not a rebase. */
  expectedVersion?: number
  sourceMessageId?: number | null
  toolCallId?: string | null
}

export interface EditResult extends WriteResult {
  replacements: number
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

export interface RenameInput extends WorkspaceScope {
  path: string
  toPath: string
  /** Move everything under `path` instead of the file at it. Directories are prefixes, not rows. */
  recursive?: boolean
}

export interface RenameResult {
  path: string
  fromPath: string
  /** Every path that moved, so one call can report what ten would have. */
  moved: string[]
  updatedAt: number
}

export interface DeleteInput extends WorkspaceScope {
  path: string
  recursive?: boolean
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
/** `_` and `%` are ordinary characters in a path, so a prefix pattern must spell them out. */
function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/** One stored row as the panel reads it. `version` is absent only for a row whose bytes are gone. */
function recordOf(file: WorkspaceFileRow, version: WorkspaceFileVersionRow | null | undefined): FileRecord {
  const mount: WorkspaceMount = file.project_id === null ? 'conversation' : 'project'
  return {
    id: file.id,
    path: `/${mount}/${file.relative_path}`,
    relativePath: file.relative_path,
    projectId: file.project_id,
    conversationId: file.conversation_id,
    fileSize: version?.file_size ?? 0,
    totalLines: version?.total_lines ?? 0,
    version: file.current_version,
    updatedAt: file.updated_at,
    createdAt: file.created_at,
    sourceConversationId: version?.source_conversation_id ?? null,
    sourceMessageId: version?.source_message_id ?? null,
  }
}

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
   * A patch named by the text it replaces, so a caller can change one line of a large file without
   * resending the rest.
   *
   * Built on `write`, which is what makes an edit an ordinary version: restorable, and guarded by
   * the version it was computed from, so a concurrent write is a conflict rather than a silent
   * clobber. Matching is literal — a regex from a model is a CPU hazard on a megabyte of text, and
   * the generation it would stall runs in this same Durable Object.
   */
  async edit(input: EditInput): Promise<Result<EditResult>> {
    const parsed = parseWorkspacePath(input.path)
    if (!parsed.ok) return fail('INVALID_PATH')
    const { mount, relativePath } = parsed.value
    if (mount === null || relativePath === '') return fail('INVALID_PATH')

    const target = this.scopeOf(mount, input)
    if (!target.ok) return target
    const existing = await this.findFile(target.value, relativePath)
    if (!existing) return fail('FILE_NOT_FOUND')
    // The named version may have rewritten the very text this patch quotes, so applying it to a
    // newer one would edit something the caller never looked at.
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.current_version) {
      return fail('VERSION_CONFLICT')
    }

    const bytes = await this.readBytes(mount, input, relativePath)
    if (!bytes.ok) return bytes
    const content = new TextDecoder().decode(bytes.value)

    const starts = matchStarts(content, input.oldText)
    if (starts.length === 0) return fail('NO_MATCH')
    // Editing the first of several is the one outcome nobody can review: it reads as success.
    if (starts.length > 1 && input.replaceAll !== true) return fail('AMBIGUOUS_MATCH')

    // Spliced by index, last first so the earlier ones stay valid. Never `replace`, which would
    // expand `$&` and `$1` in whatever the model wrote.
    const spans = input.replaceAll === true ? starts : starts.slice(0, 1)
    let next = content
    for (const start of [...spans].reverse()) {
      next = next.slice(0, start) + input.newText + next.slice(start + input.oldText.length)
    }

    const written = await this.write({
      path: input.path,
      content: next,
      expectedVersion: existing.current_version,
      conversationId: input.conversationId,
      projectId: input.projectId,
      sourceMessageId: input.sourceMessageId,
      toolCallId: input.toolCallId,
    })
    if (!written.ok) return written
    return succeed({ ...written.value, replacements: spans.length })
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
   * Moves a file to a name that is free, keeping its history and its bytes where they are.
   *
   * Crossing mounts is a move, not an error: `/conversation/notes.md` to `/project/notes.md` is how
   * a model promotes something it wrote for itself into what the whole Project can read. A taken
   * name is refused rather than resolved — renaming over a file is deleting it under another word.
   */
  async rename(input: RenameInput): Promise<Result<RenameResult>> {
    const from = parseWorkspacePath(input.path)
    const to = parseWorkspacePath(input.toPath)
    if (!from.ok || !to.ok) return fail('INVALID_PATH')
    if (from.value.mount === null || from.value.relativePath === '') return fail('INVALID_PATH')
    if (to.value.mount === null || to.value.relativePath === '') return fail('INVALID_PATH')

    const fromScope = this.scopeOf(from.value.mount, input)
    if (!fromScope.ok) return fromScope
    const toScope = this.scopeOf(to.value.mount, input)
    if (!toScope.ok) return toScope
    if (from.value.mount === to.value.mount && from.value.relativePath === to.value.relativePath) {
      return fail('FILE_ALREADY_EXISTS')
    }
    // Moving a folder into itself would rewrite the prefix it is still matching against.
    if (input.recursive === true && from.value.mount === to.value.mount
      && to.value.relativePath.startsWith(`${from.value.relativePath}/`)) {
      return fail('INVALID_PATH')
    }

    const sources = await this.resolveTargets(fromScope.value, from.value.relativePath, input.recursive === true)
    if (!sources.ok) return sources

    const now = Date.now()
    const moved: string[] = []
    for (const source of sources.value) {
      const suffix = source.relative_path.slice(from.value.relativePath.length)
      const target = `${to.value.relativePath}${suffix}`
      if (await this.findFile(toScope.value, target)) return fail('FILE_ALREADY_EXISTS')
      await this.db.update(workspaceFiles).set({
        project_id: toScope.value.projectId,
        conversation_id: toScope.value.conversationId,
        relative_path: target,
        updated_at: now,
      }).where(and(eq(workspaceFiles.id, source.id), eq(workspaceFiles.user_id, this.userId)))
      moved.push(formatWorkspacePath({ mount: to.value.mount, relativePath: target }))
    }

    return succeed({
      path: formatWorkspacePath(to.value),
      fromPath: formatWorkspacePath(from.value),
      moved,
      updatedAt: now,
    })
  }

  /**
   * What a path names: the file at it, or — with `recursive` — everything under it. A directory is
   * only ever a shared prefix here, so this is where that fiction is made explicit exactly once.
   */
  private async resolveTargets(
    scope: { projectId: number | null, conversationId: number | null },
    relativePath: string,
    recursive: boolean,
  ): Promise<Result<WorkspaceFileRow[]>> {
    const file = await this.findFile(scope, relativePath)
    if (!recursive) {
      if (file) return succeed([file])
      const [child] = await this.db.select({ id: workspaceFiles.id }).from(workspaceFiles).where(and(
        eq(workspaceFiles.user_id, this.userId),
        this.whereScope(scope),
        isNull(workspaceFiles.deleted_at),
        like(workspaceFiles.relative_path, `${escapeLike(relativePath)}/%`),
      )).limit(1)
      return fail(child ? 'IS_DIRECTORY' : 'FILE_NOT_FOUND')
    }

    const rows = await this.db.select().from(workspaceFiles).where(and(
      eq(workspaceFiles.user_id, this.userId),
      this.whereScope(scope),
      isNull(workspaceFiles.deleted_at),
      like(workspaceFiles.relative_path, `${escapeLike(relativePath)}/%`),
    )).orderBy(asc(workspaceFiles.relative_path))
    const targets = file ? [file, ...rows] : rows
    return targets.length === 0 ? fail('FILE_NOT_FOUND') : succeed(targets)
  }

  /**
   * Hides a file by path, the way the human panel hides one by id. Soft: the versions stay, the
   * path becomes free again, and the user can put it back from settings until the sweep runs.
   */
  async deleteByPath(input: DeleteInput): Promise<Result<{ path: string, deleted: string[] }>> {
    const parsed = parseWorkspacePath(input.path)
    if (!parsed.ok || parsed.value.mount === null || parsed.value.relativePath === '') return fail('INVALID_PATH')
    const scope = this.scopeOf(parsed.value.mount, input)
    if (!scope.ok) return scope

    const targets = await this.resolveTargets(scope.value, parsed.value.relativePath, input.recursive === true)
    if (!targets.ok) return targets

    const now = Date.now()
    for (const file of targets.value) {
      await this.db.update(workspaceFiles).set({ deleted_at: now })
        .where(and(eq(workspaceFiles.id, file.id), eq(workspaceFiles.user_id, this.userId)))
    }
    return succeed({
      path: formatWorkspacePath(parsed.value),
      deleted: targets.value.map(file => formatWorkspacePath({ mount: parsed.value.mount, relativePath: file.relative_path })),
    })
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

  /** Every live file in one mount, with the metadata the human panel displays. */
  async listRecords(mount: WorkspaceMount, scope: WorkspaceScope): Promise<Result<FileRecord[]>> {
    const target = this.scopeOf(mount, scope)
    if (!target.ok) return target

    const rows = await this.db.select({ file: workspaceFiles, version: workspaceFileVersions })
      .from(workspaceFiles)
      .leftJoin(workspaceFileVersions, and(
        eq(workspaceFileVersions.file_id, workspaceFiles.id),
        eq(workspaceFileVersions.version, workspaceFiles.current_version),
      ))
      .where(and(
        eq(workspaceFiles.user_id, this.userId),
        this.whereScope(target.value),
        isNull(workspaceFiles.deleted_at),
      ))
      .orderBy(asc(workspaceFiles.relative_path))

    return succeed(rows.map(({ file, version }) => ({
      id: file.id,
      path: `/${mount}/${file.relative_path}`,
      relativePath: file.relative_path,
      projectId: file.project_id,
      conversationId: file.conversation_id,
      fileSize: version?.file_size ?? 0,
      totalLines: version?.total_lines ?? 0,
      version: file.current_version,
      updatedAt: file.updated_at,
      createdAt: file.created_at,
      sourceConversationId: version?.source_conversation_id ?? null,
      sourceMessageId: version?.source_message_id ?? null,
    })))
  }

  /**
   * Gives a forked conversation its own copy of the source's `/conversation` mount.
   *
   * Rows only: every version keeps pointing at the attachment it already had, so a fork costs no
   * bytes. That sharing is safe because `purge` asks `attachmentInUse` before removing an object,
   * and the copied version rows are exactly what that question finds — emptying one conversation's
   * trash can never take the fork's content with it.
   *
   * The `/project` mount is deliberately untouched: the fork inherits `project_id`, so it already
   * addresses those files, and copying them would fork a mount the two are meant to share.
   *
   * Trashed files stay behind. The fork starts from what the conversation had, not from what it
   * threw away.
   */
  async copyConversationFiles(sourceConversationId: number, targetConversationId: number): Promise<{ files: number }> {
    const rows = await this.db.select().from(workspaceFiles).where(and(
      eq(workspaceFiles.user_id, this.userId),
      eq(workspaceFiles.conversation_id, sourceConversationId),
      isNull(workspaceFiles.deleted_at),
    ))
    if (rows.length === 0) return { files: 0 }

    for (const file of rows) {
      const [copy] = await this.db.insert(workspaceFiles).values({
        user_id: file.user_id, project_id: null, conversation_id: targetConversationId,
        relative_path: file.relative_path, current_version: file.current_version,
        created_at: file.created_at, updated_at: file.updated_at, deleted_at: null,
      }).returning()
      if (!copy) throw new Error('Could not copy workspace file onto the fork')

      const versions = await this.db.select().from(workspaceFileVersions)
        .where(eq(workspaceFileVersions.file_id, file.id))
      if (versions.length === 0) continue
      // Provenance keeps naming the message that actually wrote the bytes, which is still a message
      // in the source conversation. Remapping it here would claim the fork authored them.
      await this.db.insert(workspaceFileVersions).values(versions.map(({ id: _id, file_id: _fileId, ...version }) => ({
        ...version, file_id: copy.id,
      })))
    }
    return { files: rows.length }
  }

  /** The current bytes of one path, for serving a page's own stylesheet and script beside it. */
  async readBytes(mount: WorkspaceMount, scope: WorkspaceScope, relativePath: string): Promise<Result<Uint8Array>> {
    const target = this.scopeOf(mount, scope)
    if (!target.ok) return target

    const [row] = await this.db.select({ r2Key: attachments.r2_key })
      .from(workspaceFiles)
      .innerJoin(workspaceFileVersions, and(
        eq(workspaceFileVersions.file_id, workspaceFiles.id),
        eq(workspaceFileVersions.version, workspaceFiles.current_version),
      ))
      .innerJoin(attachments, eq(attachments.id, workspaceFileVersions.attachment_id))
      .where(and(
        eq(workspaceFiles.user_id, this.userId),
        this.whereScope(target.value),
        eq(workspaceFiles.relative_path, relativePath),
        isNull(workspaceFiles.deleted_at),
      ))
      .limit(1)
    if (!row) return fail('FILE_NOT_FOUND')

    const stored = await this.storage.getBytes(row.r2Key)
    return stored ? succeed(stored.bytes) : fail('FILE_NOT_FOUND')
  }

  /**
   * Every live file in one mount with its bytes, for an archive. A page the model wrote as several
   * files — an HTML importing its own stylesheet — is only usable if they travel together.
   */
  async readMount(mount: WorkspaceMount, scope: WorkspaceScope, prefix = ''): Promise<Result<Array<{ relativePath: string, bytes: Uint8Array }>>> {
    const target = this.scopeOf(mount, scope)
    if (!target.ok) return target

    const rows = await this.db.select({
      relativePath: workspaceFiles.relative_path,
      r2Key: attachments.r2_key,
    })
      .from(workspaceFiles)
      .innerJoin(workspaceFileVersions, and(
        eq(workspaceFileVersions.file_id, workspaceFiles.id),
        eq(workspaceFileVersions.version, workspaceFiles.current_version),
      ))
      .innerJoin(attachments, eq(attachments.id, workspaceFileVersions.attachment_id))
      .where(and(
        eq(workspaceFiles.user_id, this.userId),
        this.whereScope(target.value),
        isNull(workspaceFiles.deleted_at),
      ))
      .orderBy(asc(workspaceFiles.relative_path))

    const out: Array<{ relativePath: string, bytes: Uint8Array }> = []
    for (const row of rows) {
      // Prefix matching happens here rather than in SQL: `_` and `%` are ordinary characters in a
      // path, and a LIKE pattern would quietly treat a folder named `a_b` as matching `axb`.
      if (!row.relativePath.startsWith(prefix)) continue
      const stored = await this.storage.getBytes(row.r2Key)
      // A row whose bytes are gone is a broken file, not a reason to refuse the whole archive.
      if (stored) out.push({ relativePath: row.relativePath, bytes: stored.bytes })
    }
    return succeed(out)
  }

  /** Every live file the user owns, whichever Project or conversation holds it. */
  async listAll(): Promise<FileRecord[]> {
    const rows = await this.db.select({ file: workspaceFiles, version: workspaceFileVersions })
      .from(workspaceFiles)
      .leftJoin(workspaceFileVersions, and(
        eq(workspaceFileVersions.file_id, workspaceFiles.id),
        eq(workspaceFileVersions.version, workspaceFiles.current_version),
      ))
      .where(and(eq(workspaceFiles.user_id, this.userId), isNull(workspaceFiles.deleted_at)))
      .orderBy(asc(workspaceFiles.relative_path))
    return rows.map(row => recordOf(row.file, row.version))
  }

  /**
   * What delete left behind, excluding orphans. Every row here still names the Project or
   * conversation it came from, which is what makes "restore" a meaningful offer.
   */
  async listTrash(): Promise<Array<FileRecord & { deletedAt: number }>> {
    return this.listDeleted(and(
      or(isNotNull(workspaceFiles.project_id), isNotNull(workspaceFiles.conversation_id))!,
    )!)
  }

  /**
   * Files whose conversation was deleted out from under them. They are trashed like anything else
   * and expire on the same schedule; they are listed apart because they have no scope left to show
   * and cannot be restored to one.
   */
  async listOrphans(): Promise<Array<FileRecord & { deletedAt: number }>> {
    return this.listDeleted(and(
      isNull(workspaceFiles.project_id),
      isNull(workspaceFiles.conversation_id),
    )!)
  }

  private async listDeleted(scope: SQL): Promise<Array<FileRecord & { deletedAt: number }>> {
    const rows = await this.db.select({ file: workspaceFiles, version: workspaceFileVersions })
      .from(workspaceFiles)
      .leftJoin(workspaceFileVersions, and(
        eq(workspaceFileVersions.file_id, workspaceFiles.id),
        eq(workspaceFileVersions.version, workspaceFiles.current_version),
      ))
      .where(and(eq(workspaceFiles.user_id, this.userId), isNotNull(workspaceFiles.deleted_at), scope))
      .orderBy(desc(workspaceFiles.deleted_at))
    return rows.map(row => ({ ...recordOf(row.file, row.version), deletedAt: row.file.deleted_at! }))
  }

  /**
   * Cuts a conversation's live files loose just before the conversation row is destroyed.
   *
   * Detaching rather than letting the foreign key cascade is the whole point: a cascade deletes the
   * rows outright, which both loses content the user never chose to delete and strands the bytes in
   * R2 forever, because `purge` can only reach a file that still has a row. Trashed and scopeless,
   * they stay listable, stay reclaimable, and expire on the ordinary schedule.
   *
   * Files already in the trash keep the conversation they came from until the cascade takes it;
   * only live files are worth carrying over.
   */
  async detachConversationFiles(conversationId: number): Promise<{ files: number }> {
    const rows = await this.db.update(workspaceFiles)
      .set({ conversation_id: null, deleted_at: Date.now() })
      .where(and(
        eq(workspaceFiles.user_id, this.userId),
        eq(workspaceFiles.conversation_id, conversationId),
        isNull(workspaceFiles.deleted_at),
      ))
      .returning({ id: workspaceFiles.id })
    return { files: rows.length }
  }

  /**
   * Puts a deleted file back. The path may have been taken in the meantime — the uniqueness index
   * only covers live rows — and that is a real conflict rather than something to resolve silently.
   */
  async undelete(fileId: number): Promise<Result<FileRecord>> {
    const [file] = await this.db.select().from(workspaceFiles).where(and(
      eq(workspaceFiles.id, fileId),
      eq(workspaceFiles.user_id, this.userId),
      isNotNull(workspaceFiles.deleted_at),
    )).limit(1)
    if (!file) return fail('FILE_NOT_FOUND')
    // An orphan's conversation is gone, so there is no mount to restore it into. Saying so beats
    // reviving a row that every scoped listing would then fail to show.
    if (file.project_id === null && file.conversation_id === null) return fail('MOUNT_UNAVAILABLE')

    const [taken] = await this.db.select({ id: workspaceFiles.id }).from(workspaceFiles).where(and(
      eq(workspaceFiles.user_id, this.userId),
      this.whereScope({ projectId: file.project_id, conversationId: file.conversation_id }),
      eq(workspaceFiles.relative_path, file.relative_path),
      isNull(workspaceFiles.deleted_at),
    )).limit(1)
    if (taken) return fail('FILE_ALREADY_EXISTS')

    await this.db.update(workspaceFiles).set({ deleted_at: null, updated_at: Date.now() })
      .where(and(eq(workspaceFiles.id, fileId), eq(workspaceFiles.user_id, this.userId)))
    const [version] = await this.db.select().from(workspaceFileVersions).where(and(
      eq(workspaceFileVersions.file_id, fileId),
      eq(workspaceFileVersions.version, file.current_version),
    )).limit(1)
    return succeed(recordOf({ ...file, deleted_at: null }, version))
  }

  /**
   * Destroys deleted files for good: version rows, the pointer, and the stored bytes of any
   * attachment nothing else still points at. This is the only thing in the app that removes an
   * object from R2, which is why the reference check is exhaustive rather than optimistic.
   */
  async purge(fileIds: readonly number[]): Promise<{ files: number, bytes: number }> {
    if (fileIds.length === 0) return { files: 0, bytes: 0 }
    const files = await this.db.select().from(workspaceFiles).where(and(
      eq(workspaceFiles.user_id, this.userId),
      inArray(workspaceFiles.id, [...fileIds]),
      isNotNull(workspaceFiles.deleted_at),
    ))
    if (files.length === 0) return { files: 0, bytes: 0 }

    const ids = files.map(file => file.id)
    const versions = await this.db.select().from(workspaceFileVersions).where(inArray(workspaceFileVersions.file_id, ids))
    await this.db.delete(workspaceFileVersions).where(inArray(workspaceFileVersions.file_id, ids))
    await this.db.delete(workspaceFiles).where(and(eq(workspaceFiles.user_id, this.userId), inArray(workspaceFiles.id, ids)))

    let bytes = 0
    for (const attachmentId of new Set(versions.map(version => version.attachment_id))) {
      const [attachment] = await this.db.select().from(attachments).where(and(
        eq(attachments.id, attachmentId),
        eq(attachments.user_id, this.userId),
      )).limit(1)
      if (!attachment || await this.attachmentInUse(attachmentId)) continue
      await this.db.delete(attachments).where(eq(attachments.id, attachmentId))
      await this.storage.delete(attachment.r2_key)
      bytes += attachment.size
    }
    return { files: files.length, bytes }
  }

  /**
   * Whether anything still points at an attachment. Message parts carry `attachment_id` inside JSON
   * rather than in a column, so that one is matched as text — imprecise matching here would delete
   * bytes a message still renders.
   */
  private async attachmentInUse(attachmentId: number): Promise<boolean> {
    const [version] = await this.db.select({ id: workspaceFileVersions.id }).from(workspaceFileVersions)
      .where(eq(workspaceFileVersions.attachment_id, attachmentId)).limit(1)
    if (version) return true
    const [artifact] = await this.db.select({ id: artifacts.id }).from(artifacts)
      .where(eq(artifacts.attachment_id, attachmentId)).limit(1)
    if (artifact) return true
    const [input] = await this.db.select({ runId: artifactRunInputs.run_id }).from(artifactRunInputs)
      .where(eq(artifactRunInputs.attachment_id, attachmentId)).limit(1)
    if (input) return true
    const [icon] = await this.db.select({ id: projects.id }).from(projects)
      .where(eq(projects.icon_attachment_id, attachmentId)).limit(1)
    if (icon) return true

    // `"attachment_id":12` must not match 120, and the key may be followed by either `,` or `}`.
    const [message] = await this.db.select({ id: messages.id }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversation_id))
      .where(and(
        eq(conversations.user_id, this.userId),
        or(
          like(messages.parts as unknown as SQLiteColumn, `%"attachment_id":${attachmentId},%`),
          like(messages.parts as unknown as SQLiteColumn, `%"attachment_id":${attachmentId}}%`),
        ),
      )).limit(1)
    return message !== undefined
  }

  /** Ownership is re-checked here rather than trusted from the route. */
  private async ownedFile(fileId: number) {
    const [row] = await this.db.select().from(workspaceFiles).where(and(
      eq(workspaceFiles.id, fileId),
      eq(workspaceFiles.user_id, this.userId),
      isNull(workspaceFiles.deleted_at),
    )).limit(1)
    return row
  }

  /** The current bytes of one file, for preview and download. */
  async readById(fileId: number): Promise<Result<{ record: FileRecord, content: string, mime: string }>> {
    const file = await this.ownedFile(fileId)
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

    const mount: WorkspaceMount = file.project_id === null ? 'conversation' : 'project'
    return succeed({
      record: {
        id: file.id,
        path: `/${mount}/${file.relative_path}`,
        relativePath: file.relative_path,
        projectId: file.project_id,
        conversationId: file.conversation_id,
        fileSize: version.file_size,
        totalLines: version.total_lines,
        version: file.current_version,
        updatedAt: file.updated_at,
        createdAt: file.created_at,
        sourceConversationId: version.source_conversation_id,
        sourceMessageId: version.source_message_id,
      },
      content: new TextDecoder().decode(stored.bytes),
      mime: version.mime,
    })
  }

  /**
   * Hides a file without destroying it. Versions outlive the pointer so the bytes stay reclaimable
   * by attachment cleanup rather than disappearing with a click, and the path becomes free again
   * because the uniqueness index only covers live rows.
   */
  async softDelete(fileId: number): Promise<Result<{ id: number }>> {
    const file = await this.ownedFile(fileId)
    if (!file) return fail('FILE_NOT_FOUND')
    await this.db.update(workspaceFiles)
      .set({ deleted_at: Date.now() })
      .where(and(eq(workspaceFiles.id, fileId), eq(workspaceFiles.user_id, this.userId)))
    return succeed({ id: fileId })
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

/** How long a deleted file stays recoverable before the nightly sweep destroys it. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Destroys trashed files nobody came back for. Without it a workspace only ever grows: deleting is
 * what a user does when a file is in the way, not a promise to come back and clear it out later.
 */
export async function sweepTrash(
  db: DB,
  storage: WorkspaceStorage,
  now: number,
  retentionMs = TRASH_RETENTION_MS,
): Promise<{ files: number, bytes: number }> {
  const cutoff = now - retentionMs
  const expired = await db.select({ id: workspaceFiles.id, userId: workspaceFiles.user_id })
    .from(workspaceFiles)
    .where(and(isNotNull(workspaceFiles.deleted_at), lt(workspaceFiles.deleted_at, cutoff)))

  const byUser = new Map<number, number[]>()
  for (const row of expired) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.id])

  let files = 0
  let bytes = 0
  for (const [userId, ids] of byUser) {
    // Per user: reclaiming bytes means asking what else that user still points at.
    const result = await new WorkspaceFiles(db, storage, userId).purge(ids)
    files += result.files
    bytes += result.bytes
  }
  return { files, bytes }
}
