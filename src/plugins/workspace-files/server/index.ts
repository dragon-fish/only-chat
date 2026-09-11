import type { Context } from 'cordis'
import { tool } from 'ai'
import { WorkspaceFiles, type Result, type WorkspaceError } from '@/server/plugins/workspace-files/service'
import type { ToolContext } from '@/server/plugins/tools'
import {
  ListFilesInputSchema, READ_FILE_TOOL_ID, ReadFileInputSchema, WRITE_FILE_TOOL_ID,
  WriteFileInputSchema, LIST_FILES_TOOL_ID,
  type ListFilesOutput, type ReadFileOutput, type WriteFileOutput, type WorkspaceToolError,
} from '../shared'

export const WORKSPACE_FILES_PLUGIN_ID = 'workspace_files' as const

/** Each expected failure reads as a fact the model can act on, never as a malfunction. */
const MESSAGES: Record<WorkspaceError, string> = {
  INVALID_PATH: 'Not a valid workspace path. Paths are absolute and start with /project or /conversation, with no . or .. segments.',
  MOUNT_UNAVAILABLE: 'This conversation does not belong to a project, so /project has nowhere to store files. Use /conversation instead.',
  FILE_NOT_FOUND: 'No such file. Use list_files to see what exists.',
  FILE_ALREADY_EXISTS: 'Another write created this file first. Read it, then write again with its version.',
  VERSION_REQUIRED: 'This file already exists. Read it first and pass the version it returns as expectedVersion.',
  VERSION_CONFLICT: 'The file changed since you read it. Read it again and retry with the new version.',
  FILE_TOO_LARGE: 'Too large to store. The limit is 1 MiB of UTF-8 text.',
  INVALID_UTF8: 'Content must be valid UTF-8 text.',
  READ_RANGE_TOO_LARGE: 'That range is past the end of the file, or too large to return. Use a smaller offset and limit.',
}

function unwrap<T>(result: Result<T>): T | WorkspaceToolError {
  return result.ok ? result.value : { error: result.error, message: MESSAGES[result.error] }
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
        return output
      },
    }))

    ctx.tools.register(WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID, runtime => tool({
      description: [
        'Create a workspace file, or replace one completely. This writes the whole file; it is not a patch or pattern edit, and partial edits are not available in this release.',
        'To create a new file, omit expectedVersion. To replace an existing one, read it first and pass back the version it returned — this is what stops two writers from silently overwriting each other.',
        'A rejected write tells you why: read the file again and retry with its current version.',
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
        const { path, operation, fileSize, totalLines, version } = result.value
        return {
          path, operation, fileSize, totalLines, version,
          message: `${operation === 'created' ? 'Created' : 'Saved'} ${fileSize.toLocaleString('en-US')} bytes, ${totalLines.toLocaleString('en-US')} lines`,
        }
      },
    }))
  },
}
