import { z } from 'zod'
import type { WriteFileOutput } from '@/plugins/workspace-files/shared'

export { MEMORY_PLUGIN_ID, MEMORY_SAVE_TOOL_ID } from '@/shared/plugins'

/**
 * Where a memory lives says what it is about. Both memory mounts share the layout: two single files
 * and three folders of one file per subject.
 */
export const MEMORY_CATEGORIES = ['profile', 'preferences', 'topics', 'areas', 'people'] as const
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/** The layout, as the model is told it when a path does not fit. */
export const MEMORY_LAYOUT = 'profile.md, preferences.md, topics/<topic>.md, areas/<name>.md or people/<name>.md'

/** The category of a path inside a memory mount, or null when it follows none of the five shapes. */
export function memoryCategory(relativePath: string): MemoryCategory | null {
  if (relativePath === 'profile.md') return 'profile'
  if (relativePath === 'preferences.md') return 'preferences'
  const match = /^(topics|areas|people)\/[^/]+\.md$/.exec(relativePath)
  return match ? match[1] as MemoryCategory : null
}

export const MAX_MEMORY_DESCRIPTION = 200

/** The user's own switch: whether user memory is on anywhere at all. */
export const MEMORY_CONFIG_SCHEMA = z.object({
  user_memory: z.boolean().default(true),
})

/** Per Project: its own memory, and whether the user's memory comes into it. */
export const MEMORY_PROJECT_CONFIG_SCHEMA = z.object({
  project_memory: z.boolean().default(true),
  use_user_memory: z.boolean().default(true),
})

/** Per conversation: either layer can be left out of this one conversation. */
export const MEMORY_CONVERSATION_CONFIG_SCHEMA = z.object({
  user_memory: z.boolean().default(true),
  project_memory: z.boolean().default(true),
})

/** Which memory a conversation's turns can see. A closed layer is invisible to the model. */
export interface MemoryScopes {
  user: boolean
  project: boolean
}

export const NO_MEMORY: MemoryScopes = { user: false, project: false }

/**
 * The one rule for which layers are open, shared by the hub (what a turn may reach) and the Worker
 * (what the file panel shows). `project` is null for a conversation outside any Project. Inputs are
 * the stored settings as they are; defaults are applied here.
 */
export function memoryScopes(input: {
  config: Record<string, unknown> | undefined
  project: Record<string, unknown> | null
  conversation: Record<string, unknown> | undefined
}): MemoryScopes {
  const user = MEMORY_CONFIG_SCHEMA.parse(input.config ?? {})
  const conversation = MEMORY_CONVERSATION_CONFIG_SCHEMA.parse(input.conversation ?? {})
  if (input.project === null) return { user: user.user_memory && conversation.user_memory, project: false }
  const project = MEMORY_PROJECT_CONFIG_SCHEMA.parse(input.project)
  return {
    user: user.user_memory && project.use_user_memory && conversation.user_memory,
    project: project.project_memory && conversation.project_memory,
  }
}

export const MemorySaveInputSchema = z.strictObject({
  path: z.string().min(1).max(600)
    .describe(`The memory file: /memory/user/ (every conversation) or /memory/project/ (this Project only), followed by ${MEMORY_LAYOUT}. For example /memory/user/topics/food.md.`),
  description: z.string().min(1).max(MAX_MEMORY_DESCRIPTION).regex(/^[^\r\n]*$/, 'One line, no line breaks.')
    .describe('The catalog line: what this file covers and when it matters, so a later conversation can decide whether to open it. Not a copy of the content.'),
  content: z.string().optional()
    .describe('The whole file, as short Markdown. Omit it to change only the description of a file that already exists.'),
})
export type MemorySaveInput = z.infer<typeof MemorySaveInputSchema>

/** A save that wrote content carries the write's own fields; one that only described a file does not. */
export type MemorySaveOutput = Partial<Omit<WriteFileOutput, 'path' | 'message'>> & {
  path: string
  category: MemoryCategory
  description: string
  metadata: 'created' | 'updated'
  message: string
}

export interface MemoryToolError {
  error: string
  message: string
}

/** One memory as the management pages list it. */
export interface MemoryListItem {
  fileId: number
  path: string
  /** The file name without its extension, which is what the page titles a memory by. */
  name: string
  /** Null for a file someone put outside the layout. */
  category: MemoryCategory | null
  description: string | null
  updatedAt: number
}
