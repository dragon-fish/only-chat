import { z } from 'zod'

export {
  LIST_FILES_TOOL_ID, READ_FILE_TOOL_ID, RESTORE_FILE_TOOL_ID, WRITE_FILE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID,
} from '@/shared/plugins'

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
    .describe('Optional guard: the version you believe the file is at. Omit to overwrite whatever is there.'),
})
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>

export const RestoreFileInputSchema = z.strictObject({
  path: PathSchema.describe('The file whose history holds the version you want.'),
  version: z.number().int().min(1).describe('Which stored version to bring back.'),
  toPath: PathSchema.describe('Where to put it. Must not already exist.'),
})
export type RestoreFileInput = z.infer<typeof RestoreFileInputSchema>

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
  operation: 'created' | 'updated' | 'replaced'
  fileSize: number
  totalLines: number
  version: number
  /** Set when a version was displaced without being named; it is still restorable. */
  replacedVersion: number | null
  /**
   * Set when this turn read an older version than the one it just replaced — meaning the write went
   * over content the caller never saw. `null` when the replaced version is the one it had read, or
   * when it had not read the file at all.
   */
  staleReadVersion: number | null
  message: string
}

export interface RestoreFileOutput {
  path: string
  sourcePath: string
  restoredFrom: number
  version: number
  fileSize: number
  totalLines: number
  message: string
}

export interface WorkspaceToolError {
  error: string
  message: string
}
