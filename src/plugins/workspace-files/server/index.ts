import type { Context } from 'cordis'
import { tool } from 'ai'
import { isTextMime, WorkspaceFiles, type Result, type WorkspaceError } from '@/server/plugins/workspace-files/service'
import type { ToolContext } from '@/server/plugins/tools'
import { formatWorkspacePath, parseWorkspacePath, pathFromArgument } from '@/server/plugins/workspace-files/path'
import { fileToolError, parseFileRef, refFailure, type FileResult } from '@/plugins/file-reader/server/refs'
import { binaryFromAttachment, type FileTurn, type ResolvedFile } from '@/plugins/file-reader/server/service'
import type { Message } from '@/shared/models'
import {
  COPY_FILE_TOOL_ID, DELETE_FILE_TOOL_ID, LIST_FILES_TOOL_ID, PREVIEW_FILE_TOOL_ID, READ_FILE_TOOL_ID, RENAME_FILE_TOOL_ID,
  RESTORE_FILE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID, pluginToolIds,
} from '@/shared/plugins'
import manifest from '../manifest'
import {
  CopyFileInputSchema, DeleteFileInputSchema, EditFileInputSchema, ListFilesInputSchema, PreviewFileInputSchema,
  RenameFileInputSchema, RestoreFileInputSchema, WriteFileInputSchema,
  type CopyFileOutput, type DeleteFileOutput, type EditFileOutput, type ListFilesOutput, type PreviewFileOutput,
  type ReadFileOutput, type ReadFileUnchangedOutput,
  type RenameFileOutput, type RestoreFileOutput, type WriteFileOutput, type WorkspaceToolError,
} from '../shared'
import { absolutePreviewUrl, PREVIEW_TICKET_TTL_SECONDS, previewTypeFor, previewUrlFor } from './preview'

/** Each expected failure reads as a fact the model can act on, never as a malfunction. */
const MESSAGES: Record<WorkspaceError, string> = {
  INVALID_PATH: 'Not a valid workspace path. Paths are absolute and start with /project or /conversation (or the same as vfs:/project/…), with no . or .. segments.',
  MOUNT_UNAVAILABLE: 'This conversation does not belong to a project, so /project has nowhere to store files. Use /conversation instead.',
  FILE_NOT_FOUND: 'No such file. Use list_files to see what exists.',
  IS_DIRECTORY: 'That path holds other files rather than being one. Pass recursive: true to act on everything under it.',
  FILE_ALREADY_EXISTS: 'That name is taken. Restoring never overwrites, so choose a name nothing uses yet.',
  VERSION_CONFLICT: 'The file is not at the version you named, so someone else changed it. Read it again and decide whether to keep their work.',
  VERSION_NOT_FOUND: 'That version does not exist for this file. list_files and read_file report the current one.',
  FILE_TOO_LARGE: 'Too large to store. The limit is 1 MiB of UTF-8 text.',
  INVALID_UTF8: 'Content must be valid UTF-8 text.',
  READ_RANGE_TOO_LARGE: 'That range is past the end of the file, or too large to return. Use a smaller offset and limit.',
  NO_MATCH: 'That text is not in the file. Copy it from read_file exactly, without the line numbers printed in front of each line, and keep the original indentation.',
  READ_ONLY: 'A file reference such as asset: names a file that cannot change. copy_file it into /conversation or /project first, then work on the copy.',
  BINARY_FILE: 'This is a binary file, which can be read, copied, renamed or deleted but not written as text. Write text to a new path instead.',
  AMBIGUOUS_MATCH: 'That text appears in more than one place, and editing the first of several is the one outcome nobody can review. Include enough surrounding lines to name a single place, or pass replaceAll to change all of them.',
}

/** Not a filesystem outcome: the caller skipped a step, and the fix is to take it. */
const NOT_READ: WorkspaceToolError = {
  error: 'NOT_READ',
  message: 'Read the file before editing it — at least the part you are changing. An edit quotes text you have seen, and is checked against the version you read.',
}

function unwrap<T>(result: Result<T>): T | WorkspaceToolError {
  return result.ok ? result.value : { error: result.error, message: MESSAGES[result.error] }
}

const failure = (error: WorkspaceError): WorkspaceToolError => ({ error, message: MESSAGES[error] })

/**
 * What a path argument names (spec §4): a workspace path — bare or as `vfs:` — or a file reference.
 * Anything that is neither is an invalid path, never a reference to guess at.
 */
type PathArgument = { kind: 'path', path: string } | { kind: 'ref', ref: string, asset: boolean } | { kind: 'invalid' }

function argumentOf(input: string): PathArgument {
  const path = pathFromArgument(input)
  if (path !== null) return { kind: 'path', path }
  const parsed = parseFileRef(input)
  if (!parsed.ok || parsed.value.kind === 'path') return { kind: 'invalid' }
  return { kind: 'ref', ref: input, asset: parsed.value.kind === 'asset' }
}

/** A path for a tool that changes files: an asset is immutable, so it is `READ_ONLY`; any other scheme is no path at all. */
function writablePath(input: string): string | WorkspaceToolError {
  const argument = argumentOf(input)
  if (argument.kind === 'path') return argument.path
  return failure(argument.kind === 'ref' && argument.asset ? 'READ_ONLY' : 'INVALID_PATH')
}

/** A path for a tool that only makes sense on the workspace itself. */
function workspacePath(input: string): string | WorkspaceToolError {
  const argument = argumentOf(input)
  return argument.kind === 'path' ? argument.path : failure('INVALID_PATH')
}

const WORKSPACE_TOOL_IDS: readonly string[] = pluginToolIds(manifest)

/**
 * What this turn has seen of a file, and how it came to see it.
 *
 * `turn` is shared by every tool built for one generation and dies with it, so this cannot leak
 * between conversations. It exists so a later write can tell "I replaced the version I read" from
 * "I replaced a version I never saw", so a repeat read need not resend what is already in context,
 * and so an edit is refused against a view that never covered the file.
 */
interface SeenFile {
  version: number
  /** Stopped short, or started below the top: a part of a file cannot stand in for the file. */
  partial: boolean
  /** A write leaves the caller holding what it wrote, which is not a view of the file either. */
  source: 'read' | 'write'
}

const seenKey = (path: string) => `workspace_files:read:${path}`

function seenThisTurn(state: Map<string, unknown>, path: string): SeenFile | null {
  const value = state.get(seenKey(path))
  return typeof value === 'object' && value !== null ? value as SeenFile : null
}

/** What one finished tool call says the caller was shown, or null when it shows nothing. */
function seenInResult(name: string, content: unknown, path: string): SeenFile | null {
  if (name !== READ_FILE_TOOL_ID && name !== WRITE_FILE_TOOL_ID && name !== EDIT_FILE_TOOL_ID) return null
  if (typeof content !== 'object' || content === null) return null
  const record = content as Record<string, unknown>
  // A refusal showed the caller nothing about the file.
  if (record.error !== undefined || record.path !== path || typeof record.version !== 'number') return null
  if (name !== READ_FILE_TOOL_ID) return { version: record.version, partial: false, source: 'write' }
  if (record.unchanged === true) return { version: record.version, partial: false, source: 'read' }
  return {
    version: record.version,
    partial: record.truncated === true || (typeof record.startLine === 'number' && record.startLine > 1),
    source: 'read',
  }
}

/**
 * What the caller has been shown of a file, from everything it can see: this turn's ledger first,
 * then the messages this generation was built from. The version is what says whether it still holds.
 *
 * `latestSeen` is the newest view, whole or not — what an edit or a write is checked against.
 * `seenInContext` prefers the newest whole view, which only answers whether a repeat read can say
 * `unchanged`: a paged read after a full one does not un-see the file.
 */
function latestSeen(state: Map<string, unknown>, messages: readonly Message[], path: string): SeenFile | null {
  const live = seenThisTurn(state, path)
  if (live !== null) return live
  for (let index = messages.length - 1; index >= 0; index--) {
    for (const part of [...messages[index]!.parts].reverse()) {
      if (part.type !== 'tool_result') continue
      const seen = seenInResult(part.name, part.content, path)
      if (seen !== null) return seen
    }
  }
  return null
}

function seenInContext(state: Map<string, unknown>, messages: readonly Message[], path: string): SeenFile | null {
  const live = seenThisTurn(state, path)
  if (live !== null) return live
  let fallback: SeenFile | null = null
  for (let index = messages.length - 1; index >= 0; index--) {
    for (const part of [...messages[index]!.parts].reverse()) {
      if (part.type !== 'tool_result') continue
      const seen = seenInResult(part.name, part.content, path)
      if (seen === null) continue
      if (!seen.partial) return seen
      fallback ??= seen
    }
  }
  return fallback
}

/**
 * Runs writes to one file in the order they were called within a generation. A model may send two
 * edits of one file in the same step; run at once, both would check the version read before either
 * landed, and the second would conflict with the first. In order, the second sees the first's
 * version as its own write and applies to the file as it now is — or finds its text gone, which is
 * the true answer. Keyed in `ToolContext.turn`, so it dies with the generation; writes from other
 * conversations still meet as version conflicts.
 */
function inFileOrder<T>(turn: Map<string, unknown>, argument: string, run: () => Promise<T>): Promise<T> {
  const target = pathFromArgument(argument)
  const parsed = target === null ? null : parseWorkspacePath(target)
  if (parsed === null || !parsed.ok) return run()
  const key = `workspace_files:queue:${formatWorkspacePath(parsed.value)}`
  const previous = (turn.get(key) as Promise<unknown> | undefined) ?? Promise.resolve()
  const current = previous.then(run, run)
  turn.set(key, current.then(() => undefined, () => undefined))
  return current
}

const VFS_SCHEME = 'vfs'

/**
 * A workspace path as `read_file` sees it (spec §5.2): text reads as numbered lines with its version,
 * recording what this turn has seen so `write_file` and `edit_file` can check it; anything else is
 * shown whole.
 */
async function resolveWorkspaceFile(files: WorkspaceFiles, turn: FileTurn, path: string): Promise<FileResult<ResolvedFile>> {
  const scope = { conversationId: turn.conversationId, projectId: turn.projectId }
  const found = await files.current({ path, ...scope })
  if (!found.ok) return refFailure(found.error === 'INVALID_PATH' ? 'INVALID_FILE_REF' : 'FILE_NOT_FOUND', MESSAGES[found.error])
  const { attachment, relativePath } = found.value
  const filename = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  if (!isTextMime(found.value.version.mime)) return { ok: true, value: binaryFromAttachment(attachment, filename) }
  return {
    ok: true,
    value: {
      kind: 'text', ref: found.value.path, mime: found.value.version.mime, size: found.value.version.file_size,
      filename, attachmentId: attachment.id,
      read: range => readWorkspaceText(files, turn, found.value.path, range),
    },
  }
}

async function readWorkspaceText(
  files: WorkspaceFiles,
  turn: FileTurn,
  path: string,
  range: { offset?: number, limit?: number },
): Promise<FileResult<ReadFileOutput | ReadFileUnchangedOutput>> {
  const result = await files.read({ path, ...range, conversationId: turn.conversationId, projectId: turn.projectId })
  if (!result.ok) {
    return refFailure(result.error === 'READ_RANGE_TOO_LARGE' ? 'READ_RANGE_TOO_LARGE' : 'FILE_NOT_FOUND', MESSAGES[result.error])
  }
  const { updatedAt: _updatedAt, ...output } = result.value

  const seen = seenInContext(turn.state, turn.path, output.path)
  // Only against a previous read of the whole file: a write's entry records what was written
  // rather than a view of the file, and answering `unchanged` from it would point the caller
  // back at content from before its own edit. A ranged request is answered in full, since
  // what was seen whole says nothing about which lines this call asked for.
  const repeat = seen !== null && seen.source === 'read' && !seen.partial
    && seen.version === output.version && range.offset === undefined && range.limit === undefined
  turn.state.set(seenKey(output.path), {
    version: output.version,
    partial: output.truncated || output.startLine > 1,
    source: 'read',
  } satisfies SeenFile)
  if (!repeat) return { ok: true, value: output }
  return {
    ok: true,
    value: {
      path: output.path,
      version: output.version,
      unchanged: true,
      message: `Still v${output.version}, unchanged since you read it earlier in this turn. That result is still above you; read it again only after something writes to this file.`,
    },
  }
}

function servicesFor(runtime: ToolContext) {
  const files = new WorkspaceFiles(runtime.db, runtime.assets, runtime.userId)
  // Identity comes from the runtime, never from tool input: a tool can only reach the Conversation
  // and Project it was created inside.
  const scope = { conversationId: runtime.conversationId, projectId: runtime.projectId }
  return { files, scope }
}

export const WorkspaceFilesServerPlugin = {
  name: 'workspace-files',
  inject: ['tools', 'fileReader', 'db', 'assets', 'env', 'pluginConfig'] as const,
  apply(ctx: Context) {
    // `vfs:` and bare paths exist only while a workspace tool is on in the turn; otherwise they are
    // left unclaimed. The mount scope is the authorization, as for every tool here.
    ctx.fileReader.registerScheme(VFS_SCHEME, async (turn, body) => {
      if (!turn.toolIds.some(id => WORKSPACE_TOOL_IDS.includes(id))) return undefined
      return resolveWorkspaceFile(new WorkspaceFiles(ctx.db.orm, ctx.assets, turn.userId), turn, body)
    }, { barePaths: true })

    // A fork inherits `project_id`, so `/project` needs nothing; `/conversation` is keyed on the
    // conversation itself and would otherwise be empty under messages that talk about its files.
    // Without this the foreign key cascade would delete the rows outright, losing files the user
    // never chose to delete and stranding their bytes in R2 where nothing can reclaim them.
    ctx.on('conversation/before-purge', async ({ userId, conversationId }) => {
      const files = new WorkspaceFiles(ctx.db.orm, ctx.assets, userId)
      await files.detachConversationFiles(conversationId)
    })

    ctx.on('conversation/forked', async (payload) => {
      const files = new WorkspaceFiles(ctx.db.orm, ctx.assets, payload.userId)
      await files.copyConversationFiles(payload.sourceConversationId, payload.conversation.id)
    })

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, LIST_FILES_TOOL_ID, runtime => tool({
      description: [
        'List what exists in the workspace filesystem. Start at "/" to see which mounts are available.',
        'Returns direct children only — files and the directories containing deeper files — never file content; use read_file for that.',
        'Mounts report status: "empty" means nothing is stored there yet, "unavailable" means this conversation has no project, and "ready" means it holds files. These are three different answers, not errors.',
        'Entries include the version you need to pass back to write_file when replacing an existing file.',
      ].join(' '),
      inputSchema: ListFilesInputSchema,
      async execute(input): Promise<ListFilesOutput | WorkspaceToolError> {
        const path = workspacePath(input.path)
        if (typeof path !== 'string') return path
        const { files, scope } = servicesFor(runtime)
        const result = await files.list({ path, limit: input.limit, ...scope })
        if (!result.ok) return unwrap(result) as WorkspaceToolError
        return {
          path: result.value.path,
          entries: result.value.entries.map(entry => ({
            path: entry.path, type: entry.type, status: entry.status,
            updatedAt: entry.updatedAt, version: entry.version,
          })),
          truncated: result.value.truncated,
        }
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID, runtime => tool({
      description: [
        'Create a workspace file, or replace one completely. This writes the whole file, so use edit_file to change part of one that already exists.',
'Writing over an existing file is allowed and never loses anything: the previous version is kept and the result tells you which one was displaced, so restore_file can bring it back.',
        'Pass expectedVersion only when it matters that nobody else has touched the file meanwhile — it is a guard, not a requirement, and a mismatch means someone else moved it.',
        'Limit is 1 MiB of UTF-8 text. Every successful write stores an immutable version and advances the file to it.',
        'Files under /project are shared by every conversation in the project; files under /conversation are private to this one.',
        'This is not a disk on anyone\'s machine but a virtual filesystem kept in object storage, so there is no local path or file:// URL to hand out: the operator finds the files in the chat\'s Files panel.',
      ].join(' '),
      inputSchema: WriteFileInputSchema,
      async execute(input, options): Promise<WriteFileOutput | WorkspaceToolError> {
        // One at a time per file within this turn; see `inFileOrder`.
        return inFileOrder(runtime.turn, input.path, async () => {
          const target = writablePath(input.path)
          if (typeof target !== 'string') return target
          const { files, scope } = servicesFor(runtime)
          const result = await files.write({
            path: target,
            content: input.content,
            expectedVersion: input.expectedVersion,
            sourceMessageId: runtime.assistantMessageId,
            toolCallId: options?.toolCallId ?? null,
            ...scope,
          })
          if (!result.ok) return unwrap(result) as WorkspaceToolError
          const { path, operation, fileSize, totalLines, version, replacedVersion } = result.value
          const read = latestSeen(runtime.turn, runtime.path, path)
          // Older than what was replaced means somebody wrote in between and this write went over
          // content the caller never read.
          const staleReadVersion = read !== null && replacedVersion !== null && read.version < replacedVersion
            ? read.version
            : null
          runtime.turn.set(seenKey(path), { version, partial: false, source: 'write' } satisfies SeenFile)

          const previewable = previewTypeFor(path) !== undefined
          const size = `${fileSize.toLocaleString('en-US')} bytes, ${totalLines.toLocaleString('en-US')} lines`
          const message = operation === 'created'
            ? `Created ${size}`
            : replacedVersion === null
              ? `Saved ${size}`
              : staleReadVersion === null
                ? `Saved ${size}. Replaced v${replacedVersion}, still restorable with restore_file.`
                : `Saved ${size}. Replaced v${replacedVersion}, which was written after you read v${staleReadVersion} — you never saw it. Restore it with restore_file if that content mattered.`
          // Said here rather than minted here: a ticket per write would spend one on every draft,
          // and only the last of them is ever looked at.
          const hint = previewable ? ' This one can be opened in a browser — preview_file gives you the link.' : ''
          return {
            path, operation, previewable, fileSize, totalLines, version, replacedVersion, staleReadVersion,
            message: message + hint,
          }
        })
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, PREVIEW_FILE_TOOL_ID, runtime => tool({
      description: [
        'Get a link that opens a workspace file in a browser — yours, or the operator\'s.',
        'Use it after writing something meant to be looked at rather than read as text: a page, a stylesheet, an SVG. write_file says which files those are.',
        'The result says whether the link renders as a page or only shows source. Rendering is a setting the operator controls and it is off by default, so do not promise a rendered page unless the result says renders: page.',
        'The link expires, so fetch it when you are about to use it rather than early. Ask again for a fresh one.',
        'Relative references between files in the same mount resolve in the preview — ./style.css, ./app.js, fetch("./data.csv") — so a page split across files works as written.',
      ].join(' '),
      inputSchema: PreviewFileInputSchema,
      async execute(input): Promise<PreviewFileOutput | WorkspaceToolError> {
        const { files, scope } = servicesFor(runtime)
        const target = workspacePath(input.path)
        if (typeof target !== 'string') return target
        const parsed = parseWorkspacePath(target)
        if (!parsed.ok || parsed.value.mount === null || parsed.value.relativePath === '') {
          return { error: 'INVALID_PATH', message: MESSAGES.INVALID_PATH }
        }
        const { mount, relativePath } = parsed.value

        // Records only. Reading the file would fetch its bytes from R2 to prove it exists, and the
        // browser is about to fetch them anyway.
        const listed = await files.listRecords(mount, scope)
        if (!listed.ok) return unwrap(listed) as WorkspaceToolError
        const record = listed.value.find(entry => entry.relativePath === relativePath)
        if (!record) return { error: 'FILE_NOT_FOUND', message: MESSAGES.FILE_NOT_FOUND }

        const path = await previewUrlFor(ctx, runtime.userId, record)
        if (!path) return { error: 'MOUNT_UNAVAILABLE', message: MESSAGES.MOUNT_UNAVAILABLE }

        const config = await ctx.pluginConfig.read(runtime.userId, WORKSPACE_FILES_PLUGIN_ID)
        const renders = !isTextMime(record.mime)
          ? 'file' as const
          : config.html_preview === true && previewTypeFor(relativePath) !== undefined ? 'page' as const : 'text' as const
        const minutes = Math.round(PREVIEW_TICKET_TTL_SECONDS / 60)
        const message = renders === 'page'
          ? `Opens as a page. The link works for about ${minutes} minutes.`
          : renders === 'file'
            ? `Opens as the ${record.mime} file itself. The link works for about ${minutes} minutes.`
            : 'Opens as source text, not as a rendered page — the operator has not turned on HTML preview '
              + `for the workspace files plugin. The link works for about ${minutes} minutes.`

        return {
          path: formatWorkspacePath(parsed.value),
          url: runtime.publicOrigin === null ? path : absolutePreviewUrl(runtime.publicOrigin, path),
          renders,
          expiresInSeconds: PREVIEW_TICKET_TTL_SECONDS,
          message,
        }
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, EDIT_FILE_TOOL_ID, runtime => tool({
      description: [
        'Change part of a file by naming the text to replace. Prefer this over write_file for anything but a new file or a rewrite: sending a whole file back to change one line wastes the turn and drifts in the parts you did not mean to touch.',
        'oldText is matched literally, not as a pattern or a regular expression. It must match the file exactly, including indentation — and without the line numbers read_file prints in front of each line.',
        'It must match exactly one place, so include enough surrounding lines to be unambiguous; pass replaceAll to change every occurrence instead. An empty newText deletes the matched text.',
        'Read the file first — the part you are changing is enough; a large file can be read a page at a time. If the file changed since you read it, the edit is refused rather than applied to content you never saw.',
        'Like every write, a successful edit stores an immutable version, so restore_file can bring back what it replaced.',
      ].join(' '),
      inputSchema: EditFileInputSchema,
      async execute(input, options): Promise<EditFileOutput | WorkspaceToolError> {
        // One at a time per file within this turn; see `inFileOrder`.
        return inFileOrder(runtime.turn, input.path, async () => {
          const target = writablePath(input.path)
          if (typeof target !== 'string') return target
          const parsed = parseWorkspacePath(target)
          if (!parsed.ok) return failure('INVALID_PATH')
          // The ledger is keyed by the canonical path, which is what read_file and write_file record.
          const seen = latestSeen(runtime.turn, runtime.path, formatWorkspacePath(parsed.value))
          const { files, scope } = servicesFor(runtime)
          // Having read any part is enough. Do not require a whole read: one call returns at most 5,000
          // lines and 100 KiB, so a larger file could never be edited and only write_file — the
          // riskier tool — would reach it. Uniqueness is judged on the whole file on the server, and
          // oldText has to be quoted exactly, so an unread region cannot make a match look unique.
          // Reading a binary file records no view, so it is named as binary rather than as unread —
          // the latter would send the caller to read_file and back here forever.
          if (seen === null) {
            const found = await files.current({ path: target, ...scope })
            return found.ok && !isTextMime(found.value.version.mime) ? failure('BINARY_FILE') : NOT_READ
          }

          const result = await files.edit({
            path: target,
            oldText: input.oldText,
            newText: input.newText,
            replaceAll: input.replaceAll,
            // What the caller actually looked at this turn. A file that moved since then is a
            // conflict: the patch quotes content that may no longer be the content.
            expectedVersion: seen.version,
            sourceMessageId: runtime.assistantMessageId,
            toolCallId: options?.toolCallId ?? null,
            ...scope,
          })
          if (!result.ok) return unwrap(result) as WorkspaceToolError
          const { path, fileSize, totalLines, version, replacements } = result.value
          runtime.turn.set(seenKey(path), { version, partial: false, source: 'write' } satisfies SeenFile)

          const previewable = previewTypeFor(path) !== undefined
          const places = replacements === 1 ? 'one place' : `${replacements} places`
          const hint = previewable ? ' This one can be opened in a browser — preview_file gives you the link.' : ''
          return {
            path,
            previewable,
            operation: 'updated',
            fileSize,
            totalLines,
            version,
            replacedVersion: null,
            staleReadVersion: null,
            replacements,
            message: `Changed ${places}, saved as v${version} (${fileSize.toLocaleString('en-US')} bytes, ${totalLines.toLocaleString('en-US')} lines).${hint}`,
          }
        })
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, RESTORE_FILE_TOOL_ID, runtime => tool({
      description: [
        'Bring back an earlier version of a file, under a name that is not in use.',
        'Use it after a write replaced something you wanted to keep — the result of that write names the version it displaced.',
        'toPath must be free. Restoring never overwrites anything, because overwriting is the thing it exists to undo.',
        'The restored copy starts its own history at version 1; the original file is untouched.',
      ].join(' '),
      inputSchema: RestoreFileInputSchema,
      async execute(input, options): Promise<RestoreFileOutput | WorkspaceToolError> {
        const from = workspacePath(input.path)
        if (typeof from !== 'string') return from
        const to = workspacePath(input.toPath)
        if (typeof to !== 'string') return to
        const { files, scope } = servicesFor(runtime)
        const result = await files.restore({
          path: from,
          version: input.version,
          toPath: to,
          sourceMessageId: runtime.assistantMessageId,
          toolCallId: options?.toolCallId ?? null,
          ...scope,
        })
        if (!result.ok) return unwrap(result) as WorkspaceToolError
        const { path, sourcePath, restoredFrom, version, fileSize, totalLines } = result.value
        return {
          path, sourcePath, restoredFrom, version, fileSize, totalLines,
          message: `Restored ${sourcePath} v${restoredFrom} to ${path}`,
        }
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, RENAME_FILE_TOOL_ID, runtime => tool({
      description: [
        'Rename or move a file, keeping its history and costing no storage.',
        'toPath must be free: renaming over a file would delete that file under another word.',
        'The two paths may be in different mounts, which moves the file — /conversation to /project is how you share something you wrote for yourself with the rest of the Project.',
        'Pass recursive: true to move a directory; everything under it keeps its relative layout, so a page keeps finding the files it references.',
      ].join(' '),
      inputSchema: RenameFileInputSchema,
      async execute(input): Promise<RenameFileOutput | WorkspaceToolError> {
        const from = writablePath(input.path)
        if (typeof from !== 'string') return from
        const to = writablePath(input.toPath)
        if (typeof to !== 'string') return to
        const { files, scope } = servicesFor(runtime)
        const result = await files.rename({
          path: from,
          toPath: to,
          recursive: input.recursive,
          ...scope,
        })
        if (!result.ok) return unwrap(result) as WorkspaceToolError
        const { path, fromPath, moved } = result.value
        // What this turn read now lives at a new name; carrying it over keeps the next write's
        // "you replaced a version you never saw" warning honest.
        for (const to of moved) {
          const from = `${fromPath}${to.slice(path.length)}`
          const read = runtime.turn.get(seenKey(from))
          if (read !== undefined) runtime.turn.set(seenKey(to), read)
        }
        return {
          path,
          fromPath,
          moved,
          message: moved.length === 1
            ? `Moved ${fromPath} to ${path}`
            : `Moved ${moved.length} files from ${fromPath} to ${path}`,
        }
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, DELETE_FILE_TOOL_ID, runtime => tool({
      description: [
        'Remove a file from the workspace so later turns stop seeing it.',
        'Reversible by the user rather than by you: it goes to their trash, where it stays restorable for 30 days. Nothing you can call brings it back, so delete what is genuinely finished with, not what you are unsure about.',
        'The name becomes free again immediately.',
        'Pass recursive: true to remove a directory and everything under it.',
      ].join(' '),
      inputSchema: DeleteFileInputSchema,
      async execute(input): Promise<DeleteFileOutput | WorkspaceToolError> {
        const target = writablePath(input.path)
        if (typeof target !== 'string') return target
        const { files, scope } = servicesFor(runtime)
        const result = await files.deleteByPath({ path: target, recursive: input.recursive, ...scope })
        if (!result.ok) return unwrap(result) as WorkspaceToolError
        const { path, deleted } = result.value
        for (const gone of deleted) runtime.turn.delete(seenKey(gone))
        return {
          path,
          deleted,
          message: deleted.length === 1
            ? `Deleted ${path}. The user can restore it from their workspace settings for 30 days.`
            : `Deleted ${deleted.length} files under ${path}. The user can restore them from their workspace settings for 30 days.`,
        }
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, COPY_FILE_TOOL_ID, runtime => tool({
      description: [
        'Copy a file to a new workspace path, costing no storage: the copy shares the source\'s bytes.',
        'from is a workspace path, or a file reference such as asset:3f9a2c1e for a file shown in this conversation — which is how an uploaded or generated file gets a place in the workspace, where it can be renamed, shared through /project, or opened again in a later conversation.',
        'to must be free: copying never overwrites. The copy starts its own history at version 1.',
        'Works for text and binary files alike.',
      ].join(' '),
      inputSchema: CopyFileInputSchema,
      async execute(input, options): Promise<CopyFileOutput | WorkspaceToolError> {
        const to = writablePath(input.to)
        if (typeof to !== 'string') return to
        const argument = argumentOf(input.from)
        if (argument.kind === 'invalid') return failure('INVALID_PATH')
        let from: { path: string } | { attachment: { attachmentId: number, mime: string, size: number } }
        let fromName: string | null
        if (argument.kind === 'ref') {
          const resolved = await ctx.fileReader.resolve(ctx.fileReader.turnOf(runtime.turn), argument.ref)
          if (!resolved.ok) return fileToolError(resolved)
          const { attachmentId, mime, size, filename } = resolved.value
          if (attachmentId === undefined) return { error: 'INVALID_PATH', message: `${argument.ref} is not a stored file and cannot be copied.` }
          from = { attachment: { attachmentId, mime, size } }
          fromName = filename
        } else {
          from = { path: argument.path }
          fromName = argument.path.slice(argument.path.lastIndexOf('/') + 1)
        }

        const { files, scope } = servicesFor(runtime)
        const result = await files.copy({
          from, toPath: to, sourceMessageId: runtime.assistantMessageId, toolCallId: options?.toolCallId ?? null, ...scope,
        })
        if (!result.ok) return unwrap(result) as WorkspaceToolError
        const { path, mime, fileSize, version } = result.value
        return { path, from: input.from, fromName, mime, fileSize, version, message: `Copied ${input.from} to ${path}.` }
      },
    }))
  },
}
