import type { Context } from 'cordis'
import { tool } from 'ai'
import { and, eq } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { conversations, projects } from '@/server/db/schema'
import { formatWorkspacePath, parseWorkspacePath, pathFromArgument } from '@/server/plugins/workspace-files/path'
import { memoryOpen, openMemoryMounts } from '@/plugins/workspace-files/server/memory'
import { touchedPaths, touchPaths } from '@/plugins/workspace-files/server/touched'
import { isTextMime, WorkspaceFiles } from '@/server/plugins/workspace-files/service'
import { servicesFor, workspaceToolError, writeWorkspaceFile } from '@/plugins/workspace-files/server'
import {
  MEMORY_LAYOUT, MEMORY_PLUGIN_ID, MEMORY_SAVE_TOOL_ID, MemorySaveInputSchema, memoryCategory, memoryScopes,
  type MemoryCategory, type MemoryScopes, type MemorySaveInput, type MemorySaveOutput, type MemoryToolError,
} from '../shared'
import type { ReadMemoryFile } from './catalog'
import { absorbOwnChanges, copyState, memoryTurnNotes } from './notices'

/** Standing instructions. Static on purpose: it is part of the system prompt, ahead of the cache. */
const GUIDANCE = `You have a memory that outlives this conversation: Markdown files in the workspace.
- /memory/user/ holds what is true across all of this user's conversations.
- /memory/project/ holds what belongs to the current Project only, and does not exist outside one.

The first user message memory is on for opens with a catalog of these files in a system reminder: each layer's profile and preferences in full, then one line per other file with its description. When memory changes elsewhere later — another conversation, the user's memory page, a switch — a reminder at the end of a later user message says what changed. Your own changes are not repeated back to you. When a file looks relevant, read it before relying on it.

Both layers are laid out the same way, and where a fact goes depends on what it is about:
- profile.md: who the user is — name, occupation, employer, when they started, and whatever else will still be true in three months. Under 300 words.
- preferences.md: how the user wants you to answer — language, length, tone, format. Only requirements on your replies; their own tastes go elsewhere.
- topics/<topic>.md: the user's own habits, tastes, routines and recurring interests, one file per area of life such as food, sleep, films or dev tools. A passing mention is not worth keeping; file it once it comes up again.
- areas/<name>.md: anything they keep working on, not only formal projects — an open problem, a standing responsibility, an errand such as a house hunt, taxes or a job search. Record what was decided, what constrains it, what is due when (as absolute dates) and where it stands.
- people/<name>.md: people who matter to later conversations — family, friends, colleagues, teachers — with how they relate to the user and what they do together, not a dossier.
Name files for their subject, in the language the user talks about it in.

What is worth remembering is what a later conversation would act on and could not work out from the conversation or the workspace. Not what the workspace or the messages already hold, not what only matters right now, not guesses, and never secrets.

How much to write:
- Most facts are one line. A favourite food or film, the editor they use, a city they lived in: add a line to the file that already covers it — profile.md, preferences.md or the topic — rather than starting a file of its own.
- A subject earns its own file only when there is more to it than a line: the user told the story behind a film they love, a person keeps coming up, an errand has decisions and deadlines. Leave a one-line pointer to it in the broader file when there is one.
- Bodies are short Markdown lists, with the reason beside a fact when the user gave one. No title heading.
- The description is the catalog line: what the file covers and when it matters, in one line, so a later conversation can decide whether to open it. Update it when the file outgrows it.
- Look in the catalog before writing; add to what exists, and merge duplicates when you find them.

Keeping memory current:
- Start a file: ${MEMORY_SAVE_TOOL_ID} with content.
- Add to or correct a file with edit_file; call ${MEMORY_SAVE_TOOL_ID} without content if its description no longer fits.
- Remove what turned out wrong or outdated with edit_file, or delete_file a file with nothing left worth keeping. rename_file renames a file or moves it between /memory/user and /memory/project.
- A file listed as undescribed needs ${MEMORY_SAVE_TOOL_ID} without content; one outside the layout should be renamed into it.`

const DESCRIPTION = [
  'Start a memory file, or change the line the memory catalog shows for one.',
  'With content: writes the whole file, as write_file does — an existing file is replaced and its previous version kept — and records its description.',
  'Without content: records the description of a file that already exists, leaving the file alone.',
  `The path is /memory/user/ or /memory/project/ followed by ${MEMORY_LAYOUT}. To add to a file use edit_file; to delete or move one, delete_file or rename_file.`,
].join(' ')

const NOT_MEMORY: MemoryToolError = {
  error: 'INVALID_PATH',
  message: `${MEMORY_SAVE_TOOL_ID} only saves memory files: /memory/user/ or /memory/project/ followed by ${MEMORY_LAYOUT}. Use write_file for anywhere else.`,
}

const METADATA_CONFLICT: MemoryToolError = {
  error: 'METADATA_CONFLICT',
  message: `The content was saved, but the file changed again before its description could be recorded — something else wrote to it at the same moment. Read it, then call ${MEMORY_SAVE_TOOL_ID} without content to describe what it says now.`,
}

/** The canonical path and its category when the argument names a memory file in the layout, otherwise null. */
function memoryPath(argument: string): { path: string, category: MemoryCategory } | null {
  const raw = pathFromArgument(argument)
  const parsed = raw === null ? null : parseWorkspacePath(raw)
  if (parsed === null || !parsed.ok) return null
  const { mount, relativePath } = parsed.value
  if (mount === null || !mount.startsWith('memory/')) return null
  const category = memoryCategory(relativePath)
  return category === null ? null : { path: formatWorkspacePath(parsed.value), category }
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
    INSERT INTO memories (file_id, user_id, description, updated_at)
    SELECT id, user_id, ?1, ?2 FROM workspace_files
     WHERE id = ?3 AND user_id = ?4 AND deleted_at IS NULL
       AND mount IN ('memory/user', 'memory/project')
       AND (?5 IS NULL OR current_version = ?5)
    ON CONFLICT (file_id) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at
  `).bind(input.description, Date.now(), fileId, userId, atVersion).run()
  if (result.meta.changes === 0) return null
  return existed === null ? 'created' : 'updated'
}

/** The layers this conversation's turns may see, from the three levels of switches. */
async function scopesOf(ctx: Context, userId: number, conversationId: number, projectId: number | null): Promise<MemoryScopes> {
  const db = ctx.db.orm
  const [conversation] = await db.select({ plugin_settings: conversations.plugin_settings }).from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.user_id, userId))).limit(1)
  const [project] = projectId === null
    ? []
    : await db.select({ plugin_settings: projects.plugin_settings }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.user_id, userId))).limit(1)
  return memoryScopes({
    config: await ctx.pluginConfig.read(userId, MEMORY_PLUGIN_ID),
    project: project === undefined ? null : project.plugin_settings?.[MEMORY_PLUGIN_ID] ?? {},
    conversation: conversation?.plugin_settings?.[MEMORY_PLUGIN_ID],
  })
}

export const MemoryServerPlugin = {
  name: 'memory',
  inject: ['tools', 'db', 'assets', 'promptSections', 'pluginConfig'] as const,
  apply(ctx: Context) {
    // Only a turn that can save memories is told about them and shown them: with no memory_save the
    // mounts stay closed, the catalog stays out of the prompt, and so does the guidance.
    ctx.on('generation/prepare', async (turn) => {
      if (!turn.toolIds.includes(MEMORY_SAVE_TOOL_ID)) return
      const scopes = await scopesOf(ctx, turn.userId, turn.conversationId, turn.projectId)
      openMemoryMounts(turn.state, scopes)
      const files = new WorkspaceFiles(ctx.db.orm, ctx.assets, turn.userId)
      const scope = { conversationId: turn.conversationId, projectId: turn.projectId, memory: scopes }
      const readFile: ReadMemoryFile = async (mount, relativePath) => {
        const read = await files.readBytes(mount, scope, relativePath)
        return read.ok && isTextMime(read.value.mime) ? new TextDecoder().decode(read.value.bytes) : null
      }
      const notes = await memoryTurnNotes({
        db: ctx.db.orm, userId: turn.userId, conversationId: turn.conversationId, projectId: turn.projectId,
        scopes, path: turn.path, readFile,
      })
      // Every note goes on the user message the turn answers; the core stores it there.
      for (const note of notes) turn.notes.push({ pluginId: MEMORY_PLUGIN_ID, messageId: turn.path.at(-1)!.id, ...note })
    })

    // What the turn changed itself is now known; the rest waits for the next turn's reminder.
    ctx.on('generation/settled', async (turn) => {
      if (!turn.toolIds.includes(MEMORY_SAVE_TOOL_ID)) return
      const scopes = memoryOpen(turn.state)
      if (!scopes.user && !scopes.project) return
      await absorbOwnChanges({ db: ctx.db.orm, userId: turn.userId, conversationId: turn.conversationId, touched: touchedPaths(turn.state) })
    })

    ctx.on('conversation/forked', async (payload) => {
      // The catalog and reminders live on the messages, which the fork copies whole; what they told
      // the conversation has to come along, or the fork would be told it all again.
      await copyState(ctx.db.orm, payload.sourceConversationId, payload.conversation.id)
    })

    ctx.promptSections.register(MEMORY_PLUGIN_ID, ({ toolIds }) => toolIds.includes(MEMORY_SAVE_TOOL_ID) ? GUIDANCE : undefined)

    ctx.tools.register(MEMORY_PLUGIN_ID, MEMORY_SAVE_TOOL_ID, runtime => tool({
      description: DESCRIPTION,
      inputSchema: MemorySaveInputSchema,
      async execute(input, options): Promise<MemorySaveOutput | MemoryToolError> {
        const target = memoryPath(input.path)
        if (target === null) return NOT_MEMORY
        const { path, category } = target
        const described = { category, description: input.description }

        if (input.content !== undefined) {
          const written = await writeWorkspaceFile(runtime, { path, content: input.content }, options?.toolCallId ?? null)
          if ('error' in written) return written
          const metadata = await saveMetadata(runtime.db, runtime.userId, written.fileId, input, written.output.version)
          if (metadata === null) return METADATA_CONFLICT
          const { message, ...fields } = written.output
          return { ...fields, ...described, metadata, message: `${message}. Catalog line saved.` }
        }

        const { files, scope } = servicesFor(runtime)
        const found = await files.current({ path, ...scope })
        if (!found.ok) return workspaceToolError(found.error)
        const metadata = await saveMetadata(runtime.db, runtime.userId, found.value.version.file_id, input, null)
        if (metadata === null) return workspaceToolError('FILE_NOT_FOUND')
        touchPaths(runtime.turn, [path])
        return { path: found.value.path, ...described, metadata, message: 'Catalog line saved; the file itself is unchanged.' }
      },
    }))
  },
}
