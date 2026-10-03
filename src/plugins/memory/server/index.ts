import type { Context } from 'cordis'
import { tool } from 'ai'
import type { DB } from '@/server/db/client'
import { formatWorkspacePath, parseWorkspacePath, pathFromArgument } from '@/server/plugins/workspace-files/path'
import { openMemoryMounts } from '@/plugins/workspace-files/server/memory'
import { servicesFor, workspaceToolError, writeWorkspaceFile } from '@/plugins/workspace-files/server'
import { MEMORY_PLUGIN_ID, MEMORY_SAVE_TOOL_ID, MemorySaveInputSchema, type MemorySaveInput, type MemorySaveOutput, type MemoryToolError } from '../shared'
import { copySnapshot, memoryPreamble } from './catalog'

/** Standing instructions. Static on purpose: it is part of the system prompt, ahead of the cache. */
const GUIDANCE = `You have a memory that outlives this conversation: files in the workspace.
- /memory/user/ holds what is true across all of this user's conversations.
- /memory/project/ holds what matters only inside the current Project, and does not exist outside one.

The first user message opens with a catalog of these files as they stood when the conversation started: path, type and description. It can be stale, and memories saved since then are missing from it. When a memory looks relevant, read it before you rely on it.

What is worth remembering is what a later conversation would act on differently and could not work out for itself from the conversation or the workspace: a preference the user stated, a correction they made, an approach they confirmed, a constraint on their work, where something lives. Not what the workspace or the messages already hold, not what matters only to this conversation, not guesses about the user, and never secrets.

Every memory has a type:
- user: who the user is — role, expertise, how they like things.
- feedback: how the user wants you to work — corrections and confirmed approaches alike.
- project: ongoing work, goals and constraints. Write dates as absolute dates.
- reference: where to find something — a URL, a document, a system.

Writing a memory:
- One subject per file, named for it in kebab-case, such as /memory/user/package-manager.md.
- The description is how a later conversation decides whether to open the file: one line saying what the memory is about and when it matters. It is not a copy of the body.
- The body says what the description cannot. Lead with the fact or rule itself. For feedback and project, follow it with a "**Why:**" line — the reason the user gave, or what happened — and a "**How to apply:**" line — when it applies and what to do then. Leave a line out rather than invent it. No title heading, and no restating the description.
- Before creating a memory, look in the catalog for one on the same subject and update that one instead. Merge duplicates when you find them.

Keeping memory current:
- Create a memory: ${MEMORY_SAVE_TOOL_ID} with content.
- Change what a memory says: read_file it, then edit_file it.
- Change only its type or description: ${MEMORY_SAVE_TOOL_ID} without content. A file listed as undescribed needs this too.
- A memory that turned out wrong or outdated: delete_file it. To rename one, or move it between /memory/user and /memory/project: rename_file.`

const DESCRIPTION = [
  'Create a memory, or change the line the memory catalog shows for one.',
  'With content: writes the whole file, as write_file does — an existing file is replaced and its previous version kept — and records its type and description.',
  'Without content: records the type and description of a file that already exists, leaving the file alone.',
  'The path must be under /memory/user/ or /memory/project/. To change part of a memory use edit_file; to delete or move one, delete_file or rename_file.',
].join(' ')

const NOT_MEMORY: MemoryToolError = {
  error: 'INVALID_PATH',
  message: `${MEMORY_SAVE_TOOL_ID} only saves files under /memory/user/ or /memory/project/. Use write_file for anywhere else.`,
}

const METADATA_CONFLICT: MemoryToolError = {
  error: 'METADATA_CONFLICT',
  message: `The content was saved, but the file changed again before its description could be recorded — something else wrote to it at the same moment. Read it, then call ${MEMORY_SAVE_TOOL_ID} without content to describe what it says now.`,
}

/** The canonical path when the argument names a file inside a memory mount, otherwise null. */
function memoryPath(argument: string): string | null {
  const raw = pathFromArgument(argument)
  const parsed = raw === null ? null : parseWorkspacePath(raw)
  if (parsed === null || !parsed.ok) return null
  const { mount, relativePath } = parsed.value
  return mount !== null && mount.startsWith('memory/') && relativePath !== '' ? formatWorkspacePath(parsed.value) : null
}

/**
 * Records a file's catalog line, in one statement so nothing can land between the check and the
 * write. With `atVersion`, only while the file is still at the version the caller just wrote: a
 * description written over someone else's newer content would describe text it never saw. Null
 * when the file moved on, left `/memory`, or was deleted.
 */
async function saveMetadata(
  db: DB, userId: number, fileId: number, input: MemorySaveInput, atVersion: number | null,
): Promise<'created' | 'updated' | null> {
  const existed = await db.$client.prepare('SELECT 1 FROM memories WHERE file_id = ?1').bind(fileId).first()
  const result = await db.$client.prepare(`
    INSERT INTO memories (file_id, user_id, type, description, updated_at)
    SELECT id, user_id, ?1, ?2, ?3 FROM workspace_files
     WHERE id = ?4 AND user_id = ?5 AND deleted_at IS NULL
       AND mount IN ('memory/user', 'memory/project')
       AND (?6 IS NULL OR current_version = ?6)
    ON CONFLICT (file_id) DO UPDATE SET type = excluded.type, description = excluded.description, updated_at = excluded.updated_at
  `).bind(input.type, input.description, Date.now(), fileId, userId, atVersion).run()
  if (result.meta.changes === 0) return null
  return existed === null ? 'created' : 'updated'
}

export const MemoryServerPlugin = {
  name: 'memory',
  inject: ['tools', 'db', 'promptSections'] as const,
  apply(ctx: Context) {
    // Only a turn that can save memories is told about them and shown them: with no memory_save the
    // mounts stay closed, the catalog stays out of the prompt, and so does the guidance.
    ctx.on('generation/prepare', async (turn) => {
      if (!turn.toolIds.includes(MEMORY_SAVE_TOOL_ID)) return
      openMemoryMounts(turn.state)
      turn.preamble = await memoryPreamble(ctx.db.orm, turn.userId, turn.conversationId, turn.projectId)
    })

    ctx.on('conversation/forked', async (payload) => {
      await copySnapshot(ctx.db.orm, payload.sourceConversationId, payload.conversation.id)
    })

    ctx.promptSections.register(MEMORY_PLUGIN_ID, ({ toolIds }) => toolIds.includes(MEMORY_SAVE_TOOL_ID) ? GUIDANCE : undefined)

    ctx.tools.register(MEMORY_PLUGIN_ID, MEMORY_SAVE_TOOL_ID, runtime => tool({
      description: DESCRIPTION,
      inputSchema: MemorySaveInputSchema,
      async execute(input, options): Promise<MemorySaveOutput | MemoryToolError> {
        const path = memoryPath(input.path)
        if (path === null) return NOT_MEMORY
        const described = { type: input.type, description: input.description }

        if (input.content !== undefined) {
          const written = await writeWorkspaceFile(runtime, { path, content: input.content }, options?.toolCallId ?? null)
          if ('error' in written) return written
          const metadata = await saveMetadata(runtime.db, runtime.userId, written.fileId, input, written.output.version)
          if (metadata === null) return METADATA_CONFLICT
          const { message, ...fields } = written.output
          return { ...fields, ...described, metadata, message: `${message}. Catalogued as ${input.type}.` }
        }

        const { files, scope } = servicesFor(runtime)
        const found = await files.current({ path, ...scope })
        if (!found.ok) return workspaceToolError(found.error)
        const metadata = await saveMetadata(runtime.db, runtime.userId, found.value.version.file_id, input, null)
        if (metadata === null) return workspaceToolError('FILE_NOT_FOUND')
        return { path: found.value.path, ...described, metadata, message: 'Catalog line saved; the file itself is unchanged.' }
      },
    }))
  },
}
