import { z } from 'zod'

export {
  DELETE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID, LIST_FILES_TOOL_ID, PREVIEW_FILE_TOOL_ID, READ_FILE_TOOL_ID,
  RENAME_FILE_TOOL_ID, RESTORE_FILE_TOOL_ID, WRITE_FILE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID,
} from '@/shared/plugins'

/**
 * Rendering model-written HTML is opt-in and off by default. Off, the app only ever shows source
 * text; on, a page is served to a sandboxed frame so its own stylesheet and script resolve.
 */
export const WORKSPACE_FILES_CONFIG_SCHEMA = z.object({
  html_preview: z.boolean().default(false),
})
export type WorkspaceFilesConfig = z.infer<typeof WORKSPACE_FILES_CONFIG_SCHEMA>

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

export const EditFileInputSchema = z.strictObject({
  path: PathSchema,
  oldText: z.string().min(1)
    .describe('The exact text to replace, copied from the file itself — indentation included, and without the line numbers read_file prints in front of each line.'),
  newText: z.string().describe('What to put in its place. An empty string deletes the matched text.'),
  replaceAll: z.boolean().default(false)
    .describe('Replace every occurrence. Without it, oldText has to appear exactly once.'),
})
export type EditFileInput = z.infer<typeof EditFileInputSchema>

export const RestoreFileInputSchema = z.strictObject({
  path: PathSchema.describe('The file whose history holds the version you want.'),
  version: z.number().int().min(1).describe('Which stored version to bring back.'),
  toPath: PathSchema.describe('Where to put it. Must not already exist.'),
})
export type RestoreFileInput = z.infer<typeof RestoreFileInputSchema>

export const RenameFileInputSchema = z.strictObject({
  path: PathSchema.describe('The file, or with recursive, the directory to move.'),
  toPath: PathSchema.describe('Where it should end up. Must not already exist. May be in the other mount, which moves between the conversation and its project.'),
  recursive: z.boolean().default(false)
    .describe('Move everything under path instead of the file at it, keeping the layout inside.'),
})
export type RenameFileInput = z.infer<typeof RenameFileInputSchema>

export const DeleteFileInputSchema = z.strictObject({
  path: PathSchema.describe('The file, or with recursive, the directory to remove.'),
  recursive: z.boolean().default(false).describe('Remove everything under path instead of the file at it.'),
})
export type DeleteFileInput = z.infer<typeof DeleteFileInputSchema>

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
  /** Whether this file has a preview worth opening; see preview_file. */
  previewable: boolean
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

export interface RenameFileOutput {
  path: string
  fromPath: string
  /** Every path that moved: one call reports what ten separate ones would have. */
  moved: string[]
  message: string
}

export interface DeleteFileOutput {
  path: string
  deleted: string[]
  message: string
}

/** A `write_file` result plus how many places changed; an edit stores an ordinary new version. */
export interface EditFileOutput extends WriteFileOutput {
  replacements: number
}

export interface WorkspaceToolError {
  error: string
  message: string
}

export const PreviewFileInputSchema = z.strictObject({
  path: PathSchema,
})
export type PreviewFileInput = z.infer<typeof PreviewFileInputSchema>

export interface PreviewFileOutput {
  path: string
  /** Absolute, so it can be opened by a browser that is not already on this origin. */
  url: string
  /**
   * `page` when the link opens as a rendered page, `text` when it only shows source. Off is the
   * default, so a link is worth far less than it looks until the operator turns preview on.
   */
  renders: 'page' | 'text'
  /** The link stops working after this. Tickets are deliberately short-lived. */
  expiresInSeconds: number
  message: string
}
