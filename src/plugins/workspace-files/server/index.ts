import type { Context } from 'cordis'
import { tool } from 'ai'
import { WorkspaceFiles, type Result, type WorkspaceError } from '@/server/plugins/workspace-files/service'
import type { ToolContext } from '@/server/plugins/tools'
import { formatWorkspacePath, isProjectedMount, parseWorkspacePath } from '@/server/plugins/workspace-files/path'
import { resolveProjected } from '@/server/plugins/workspace-files/projections'
import { stripToolAttachments, TOOL_ATTACHMENTS_KEY } from '@/shared/parts'
import {
  DELETE_FILE_TOOL_ID, LIST_FILES_TOOL_ID, PREVIEW_FILE_TOOL_ID, READ_FILE_TOOL_ID, RENAME_FILE_TOOL_ID,
  RESTORE_FILE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID,
} from '@/shared/plugins'
import {
  DeleteFileInputSchema, EditFileInputSchema, ListFilesInputSchema, PreviewFileInputSchema, ReadFileInputSchema,
  RenameFileInputSchema, RestoreFileInputSchema, WriteFileInputSchema,
  type DeleteFileOutput, type EditFileOutput, type ListFilesOutput, type PreviewFileOutput,
  type ReadFileOutput, type ReadFileUnchangedOutput, type ReadImageOutput,
  type RenameFileOutput, type RestoreFileOutput, type WriteFileOutput, type WorkspaceToolError,
} from '../shared'
import { absolutePreviewUrl, PREVIEW_TICKET_TTL_SECONDS, previewTypeFor, previewUrlFor } from './preview'

/** Each expected failure reads as a fact the model can act on, never as a malfunction. */
const MESSAGES: Record<WorkspaceError, string> = {
  INVALID_PATH: 'Not a valid workspace path. Paths are absolute and start with /project, /conversation, /artifacts or /uploads, with no . or .. segments.',
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
  READ_ONLY: '/artifacts and /uploads show images this conversation already has and cannot be changed. Write your own files under /conversation or /project.',
  AMBIGUOUS_MATCH: 'That text appears in more than one place, and editing the first of several is the one outcome nobody can review. Include enough surrounding lines to name a single place, or pass replaceAll to change all of them.',
}

/** Not a filesystem outcome: the caller skipped a step, and the fix is to take it. */
const NOT_READ: WorkspaceToolError = {
  error: 'NOT_READ',
  message: 'Read the whole file in this turn before editing it. An edit names text you believe is in the file, and a view that stopped short — or never happened — is not knowing what else the file says.',
}

function unwrap<T>(result: Result<T>): T | WorkspaceToolError {
  return result.ok ? result.value : { error: result.error, message: MESSAGES[result.error] }
}

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

function seenThisTurn(runtime: ToolContext, path: string): SeenFile | null {
  const value = runtime.turn.get(seenKey(path))
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
 * What the caller knows about a file, from everything it can see.
 *
 * Keeping this per generation made every turn re-read a file the conversation had already been
 * shown — and a read is not one message but a whole round trip, which resends the conversation to
 * be told what is already on screen. The messages this generation was built from are that record,
 * and the version is what says whether it still holds.
 *
 * The newest whole view wins over a later partial one: a paged read after a full one does not
 * un-see the file, and a version that has moved since is refused either way.
 */
function seenInContext(runtime: ToolContext, path: string): SeenFile | null {
  const live = seenThisTurn(runtime, path)
  if (live !== null) return live
  let fallback: SeenFile | null = null
  for (let index = runtime.path.length - 1; index >= 0; index--) {
    for (const part of [...runtime.path[index]!.parts].reverse()) {
      if (part.type !== 'tool_result') continue
      const seen = seenInResult(part.name, part.content, path)
      if (seen === null) continue
      if (!seen.partial) return seen
      fallback ??= seen
    }
  }
  return fallback
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
  inject: ['tools', 'db', 'assets', 'env', 'pluginConfig'] as const,
  apply(ctx: Context) {
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
        const { files, scope } = servicesFor(runtime)
        const result = await files.list({ path: input.path, limit: input.limit, ...scope })
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

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, READ_FILE_TOOL_ID, runtime => tool({
      description: [
        'Read a UTF-8 text file from the workspace. Results are returned using cat -n format, with line numbers starting at 1, so you can cite positions back — strip that prefix before passing text to edit_file.',
        'Reads up to 2,000 lines and 100 KiB per call. If you already know which part you need, pass offset and limit rather than reading the whole file — on a large file that is the difference between one cheap call and several expensive ones.',
        'When the result is truncated, nextOffset tells you where to continue. Nothing is ever dropped silently.',
        'An empty file is reported as empty rather than as a blank line, which is how you tell it from a file holding a single newline.',
        'Keep the version from the result: write_file needs it to replace this file.',
        'Reading a file this turn already read whole, with nothing written to it since, answers `unchanged` instead of the content — the earlier result is still above you and says what the file holds.',
        'Do not re-read a file immediately after write_file returned its metadata — you already have the version and line count.',
        'Images under /artifacts (generated in this conversation) and /uploads (sent by the user) are shown to you as images when you read them; offset and limit do not apply.',
      ].join(' '),
      inputSchema: ReadFileInputSchema,
      // The model reads the output without the reserved key; the images arrive in the message after it.
      toModelOutput: ({ output }) => ({ type: 'json', value: stripToolAttachments(output) as never }),
      async execute(input): Promise<ReadFileOutput | ReadFileUnchangedOutput | ReadImageOutput | WorkspaceToolError> {
        const target = parseWorkspacePath(input.path)
        if (target.ok && isProjectedMount(target.value.mount)) {
          const image = await resolveProjected(runtime.db, runtime.userId, runtime.conversationId, input.path)
          if (!image) return { error: 'FILE_NOT_FOUND', message: MESSAGES.FILE_NOT_FOUND }
          const facts = { path: image.path, mime: image.mime, width: image.width, height: image.height, fileSize: image.size }
          if (!runtime.acceptsImages) {
            return { ...facts, image: 'unsupported', message: 'This model cannot view images.' }
          }
          return { ...facts, image: 'shown', message: 'The image follows this result.', [TOOL_ATTACHMENTS_KEY]: [image.attachmentId] } as ReadImageOutput
        }
        const { files, scope } = servicesFor(runtime)
        const result = await files.read({ path: input.path, offset: input.offset, limit: input.limit, ...scope })
        if (!result.ok) return unwrap(result) as WorkspaceToolError
        const { updatedAt: _updatedAt, ...output } = result.value

        const seen = seenInContext(runtime, output.path)
        // Only against a previous read of the whole file: a write's entry records what was written
        // rather than a view of the file, and answering `unchanged` from it would point the caller
        // back at content from before its own edit. A ranged request is answered in full, since
        // what was seen whole says nothing about which lines this call asked for.
        const repeat = seen !== null && seen.source === 'read' && !seen.partial
          && seen.version === output.version && input.offset === undefined && input.limit === undefined
        runtime.turn.set(seenKey(output.path), {
          version: output.version,
          partial: output.truncated || output.startLine > 1,
          source: 'read',
        } satisfies SeenFile)
        if (!repeat) return output
        return {
          path: output.path,
          version: output.version,
          unchanged: true,
          message: `Still v${output.version}, unchanged since you read it earlier in this turn. That result is still above you; read it again only after something writes to this file.`,
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
      ].join(' '),
      inputSchema: WriteFileInputSchema,
      async execute(input, options): Promise<WriteFileOutput | WorkspaceToolError> {
        const { files, scope } = servicesFor(runtime)
        const result = await files.write({
          path: input.path,
          content: input.content,
          expectedVersion: input.expectedVersion,
          sourceMessageId: runtime.assistantMessageId,
          toolCallId: options?.toolCallId ?? null,
          ...scope,
        })
        if (!result.ok) return unwrap(result) as WorkspaceToolError
        const { path, operation, fileSize, totalLines, version, replacedVersion } = result.value
        const read = seenInContext(runtime, path)
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
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, PREVIEW_FILE_TOOL_ID, runtime => tool({
      description: [
        'Get a link that opens a workspace file in a browser — yours, or the operator\'s.',
        'Use it after writing something meant to be looked at rather than read as text: a page, a stylesheet, an SVG. write_file says which files those are.',
        'The result says whether the link renders as a page or only shows source. Rendering is a setting the operator controls and it is off by default, so do not promise a rendered page unless the result says renders: page.',
        'The link expires, so fetch it when you are about to use it rather than early. Ask again for a fresh one.',
      ].join(' '),
      inputSchema: PreviewFileInputSchema,
      async execute(input): Promise<PreviewFileOutput | WorkspaceToolError> {
        const { files, scope } = servicesFor(runtime)
        const parsed = parseWorkspacePath(input.path)
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
        const renders = config.html_preview === true && previewTypeFor(relativePath) !== undefined
          ? 'page' as const
          : 'text' as const
        const minutes = Math.round(PREVIEW_TICKET_TTL_SECONDS / 60)
        const message = renders === 'page'
          ? `Opens as a page. The link works for about ${minutes} minutes.`
          : 'Opens as source text, not as a rendered page — the operator has not turned on HTML preview '
            + `for the workspace files plugin. The link works for about ${minutes} minutes.`

        return {
          path: input.path,
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
        'Read the file in this turn first. Editing text you have not just looked at is how a patch lands on a file that has since changed; if it did change, the edit is refused rather than applied to content you never saw.',
        'Like every write, a successful edit stores an immutable version, so restore_file can bring back what it replaced.',
      ].join(' '),
      inputSchema: EditFileInputSchema,
      async execute(input, options): Promise<EditFileOutput | WorkspaceToolError> {
        const parsed = parseWorkspacePath(input.path)
        if (!parsed.ok) return { error: 'INVALID_PATH', message: MESSAGES.INVALID_PATH }
        // The ledger is keyed by the canonical path, which is what read_file and write_file record.
        const seen = seenInContext(runtime, formatWorkspacePath(parsed.value))
        // A view that stopped short is not knowing what the file says, even when the text being
        // named happens to be unique: what makes it unique is the part nobody looked at.
        if (seen === null || seen.partial) return NOT_READ

        const { files, scope } = servicesFor(runtime)
        const result = await files.edit({
          path: input.path,
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
        const { files, scope } = servicesFor(runtime)
        const result = await files.restore({
          path: input.path,
          version: input.version,
          toPath: input.toPath,
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
        const { files, scope } = servicesFor(runtime)
        const result = await files.rename({
          path: input.path,
          toPath: input.toPath,
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
        const { files, scope } = servicesFor(runtime)
        const result = await files.deleteByPath({ path: input.path, recursive: input.recursive, ...scope })
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
  },
}
