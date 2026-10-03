import { z } from 'zod'
import type { WriteFileOutput } from '@/plugins/workspace-files/shared'

export { MEMORY_PLUGIN_ID, MEMORY_SAVE_TOOL_ID } from '@/shared/plugins'

/** What kind of thing a memory records. The catalog shows it, so the model can tell them apart. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const MAX_MEMORY_DESCRIPTION = 200

export const MemorySaveInputSchema = z.strictObject({
  path: z.string().min(1).max(600)
    .describe('The memory file, under /memory/user/ (every conversation) or /memory/project/ (this Project only), for example /memory/user/reply-style.md.'),
  type: z.enum(MEMORY_TYPES)
    .describe('user: who the user is. feedback: how they want you to work. project: ongoing work and its constraints. reference: where to find something.'),
  description: z.string().min(1).max(MAX_MEMORY_DESCRIPTION).regex(/^[^\r\n]*$/, 'One line, no line breaks.')
    .describe('The catalog line: what this memory is about and when it matters, so a later conversation can decide whether to open it. Not a copy of the content.'),
  content: z.string().optional()
    .describe('The whole file: the fact or rule first, then for feedback and project a **Why:** line and a **How to apply:** line when they are known. Omit it to change only the type and description of a file that already exists.'),
})
export type MemorySaveInput = z.infer<typeof MemorySaveInputSchema>

/** A save that wrote content carries the write's own fields; one that only described a file does not. */
export type MemorySaveOutput = Partial<Omit<WriteFileOutput, 'path' | 'message'>> & {
  path: string
  type: MemoryType
  description: string
  metadata: 'created' | 'updated'
  message: string
}

export interface MemoryToolError {
  error: string
  message: string
}
