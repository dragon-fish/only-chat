import type { Context } from 'cordis'
import { tool } from 'ai'
import { WorkspaceFiles, type Result, type WorkspaceError } from '@/server/plugins/workspace-files/service'
import type { ToolContext } from '@/server/plugins/tools'
import {
  DELETE_FILE_TOOL_ID, LIST_FILES_TOOL_ID, READ_FILE_TOOL_ID, RENAME_FILE_TOOL_ID,
  RESTORE_FILE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID,
} from '@/shared/plugins'
import {
  DeleteFileInputSchema, ListFilesInputSchema, ReadFileInputSchema, RenameFileInputSchema,
  RestoreFileInputSchema, WriteFileInputSchema,
  type DeleteFileOutput, type ListFilesOutput, type ReadFileOutput, type RenameFileOutput,
  type RestoreFileOutput, type WriteFileOutput, type WorkspaceToolError,
} from '../shared'

/** Each expected failure reads as a fact the model can act on, never as a malfunction. */
const MESSAGES: Record<WorkspaceError, string> = {
  INVALID_PATH: 'Not a valid workspace path. Paths are absolute and start with /project or /conversation, with no . or .. segments.',
  MOUNT_UNAVAILABLE: 'This conversation does not belong to a project, so /project has nowhere to store files. Use /conversation instead.',
  FILE_NOT_FOUND: 'No such file. Use list_files to see what exists.',
  IS_DIRECTORY: 'That path holds other files rather than being one. Pass recursive: true to act on everything under it.',
  FILE_ALREADY_EXISTS: 'That name is taken. Restoring never overwrites, so choose a name nothing uses yet.',
  VERSION_CONFLICT: 'The file is not at the version you named, so someone else changed it. Read it again and decide whether to keep their work.',
  VERSION_NOT_FOUND: 'That version does not exist for this file. list_files and read_file report the current one.',
  FILE_TOO_LARGE: 'Too large to store. The limit is 1 MiB of UTF-8 text.',
  INVALID_UTF8: 'Content must be valid UTF-8 text.',
  READ_RANGE_TOO_LARGE: 'That range is past the end of the file, or too large to return. Use a smaller offset and limit.',
}

function unwrap<T>(result: Result<T>): T | WorkspaceToolError {
  return result.ok ? result.value : { error: result.error, message: MESSAGES[result.error] }
}

/**
 * Where this turn records the version of each file it read.
 *
 * `turn` is shared by every tool built for one generation and dies with it, so this cannot leak
 * between conversations. It exists so a later write can tell "I replaced the version I read" from
 * "I replaced a version I never saw".
 */
const readVersionKey = (path: string) => `workspace_files:read:${path}`

function servicesFor(runtime: ToolContext) {
  const files = new WorkspaceFiles(runtime.db, runtime.assets, runtime.userId)
  // Identity comes from the runtime, never from tool input: a tool can only reach the Conversation
  // and Project it was created inside.
  const scope = { conversationId: runtime.conversationId, projectId: runtime.projectId }
  return { files, scope }
}

export const WorkspaceFilesServerPlugin = {
  name: 'workspace-files',
  inject: ['tools'] as const,
  apply(ctx: Context) {
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
        'Read a UTF-8 text file from the workspace. Content comes back as numbered lines, 1-based, so you can cite positions back.',
        'Reads up to 2,000 lines and 100 KiB per call. If you already know which part you need, pass offset and limit rather than reading the whole file — on a large file that is the difference between one cheap call and several expensive ones.',
        'When the result is truncated, nextOffset tells you where to continue. Nothing is ever dropped silently.',
        'An empty file is reported as empty rather than as a blank line, which is how you tell it from a file holding a single newline.',
        'Keep the version from the result: write_file needs it to replace this file.',
        'Do not re-read a file immediately after write_file returned its metadata — you already have the version and line count.',
      ].join(' '),
      inputSchema: ReadFileInputSchema,
      async execute(input): Promise<ReadFileOutput | WorkspaceToolError> {
        const { files, scope } = servicesFor(runtime)
        const result = await files.read({ path: input.path, offset: input.offset, limit: input.limit, ...scope })
        if (!result.ok) return unwrap(result) as WorkspaceToolError
        const { updatedAt: _updatedAt, ...output } = result.value
        runtime.turn.set(readVersionKey(output.path), output.version)
        return output
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID, runtime => tool({
      description: [
        'Create a workspace file, or replace one completely. This writes the whole file; it is not a patch or pattern edit, and partial edits are not available in this release.',
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
        const read = runtime.turn.get(readVersionKey(path))
        // Older than what was replaced means somebody wrote in between and this write went over
        // content the caller never read.
        const staleReadVersion = typeof read === 'number' && replacedVersion !== null && read < replacedVersion
          ? read
          : null
        runtime.turn.set(readVersionKey(path), version)

        const size = `${fileSize.toLocaleString('en-US')} bytes, ${totalLines.toLocaleString('en-US')} lines`
        const message = operation === 'created'
          ? `Created ${size}`
          : replacedVersion === null
            ? `Saved ${size}`
            : staleReadVersion === null
              ? `Saved ${size}. Replaced v${replacedVersion}, still restorable with restore_file.`
              : `Saved ${size}. Replaced v${replacedVersion}, which was written after you read v${staleReadVersion} — you never saw it. Restore it with restore_file if that content mattered.`
        return { path, operation, fileSize, totalLines, version, replacedVersion, staleReadVersion, message }
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
          const read = runtime.turn.get(readVersionKey(from))
          if (read !== undefined) runtime.turn.set(readVersionKey(to), read)
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
        for (const gone of deleted) runtime.turn.delete(readVersionKey(gone))
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
