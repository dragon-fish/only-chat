import { z } from 'zod'

export const LIST_FILES_TOOL_ID = 'list_files' as const
export const READ_FILE_TOOL_ID = 'read_file' as const
export const WRITE_FILE_TOOL_ID = 'write_file' as const

/**
 * Paths are validated again by the service; this only keeps obvious nonsense out of the model's
 * way early enough to be corrected in the same turn.
 */
const PathSchema = z.string().min(1).max(600).describe('Absolute workspace path, for example /project/report.md')

export const ListFilesInputSchema = z.strictObject({
  path: PathSchema.default('/'),
  limit: z.number().int().min(1).max(500).default(100),
})
export type ListFilesInput = z.infer<typeof ListFilesInputSchema>

export const ReadFileInputSchema = z.strictObject({
  path: PathSchema,
  offset: z.number().int().min(1).optional().describe('1-based first line to return.'),
  limit: z.number().int().min(1).max(5000).optional().describe('How many lines to return.'),
})
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>

export const WriteFileInputSchema = z.strictObject({
  path: PathSchema,
  content: z.string().describe('The complete new contents. This is a whole-file replacement.'),
  expectedVersion: z.number().int().min(1).optional()
    .describe('The version read_file or list_files returned. Omit only when creating a new file.'),
})
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>

/** Shapes the tool cards render. Tool results are persisted, so these are part of the wire format. */
export interface ListFilesOutput {
  path: string
  entries: Array<{
    path: string
    type: 'mount' | 'directory' | 'file'
    status?: 'empty' | 'ready' | 'unavailable'
    updatedAt?: number
    version?: number
  }>
  truncated: boolean
}

export interface ReadFileOutput {
  path: string
  content: string
  startLine: number
  returnedLines: number
  totalLines: number
  fileSize: number
  version: number
  truncated: boolean
  nextOffset: number | null
  empty: boolean
}

export interface WriteFileOutput {
  path: string
  operation: 'created' | 'updated'
  fileSize: number
  totalLines: number
  version: number
  message: string
}

export interface WorkspaceToolError {
  error: string
  message: string
}
