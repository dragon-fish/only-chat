import { z } from 'zod'

export { ANALYZE_FILE_TOOL_ID, FILE_UNDERSTANDING_PLUGIN_ID, VIEW_FILE_TOOL_ID } from '@/shared/plugins'

const FileRefSchema = z.string().min(1).max(600)
  .describe('A file reference, such as asset:3f9a2c1e from a file label in this conversation, or vfs:/project/report.pdf for a workspace file.')

export const ViewFileInputSchema = z.strictObject({ file: FileRefSchema })
export type ViewFileInput = z.infer<typeof ViewFileInputSchema>

export const AnalyzeFileInputSchema = z.strictObject({
  file: FileRefSchema,
  question: z.string().min(1).optional()
    .describe('What you want to know about the file. Omit it for a complete, detailed description.'),
})
export type AnalyzeFileInput = z.infer<typeof AnalyzeFileInputSchema>

/** Tool results are persisted, so these are part of the wire format. */
export interface ViewFileOutput {
  file: string
  mime: string
  message: string
}

export interface AnalyzeFileOutput {
  file: string
  mime: string
  model: { provider_id: number, model_id: string }
  text: string
  /** The analysis stopped at the service model's output limit, so `text` is incomplete. */
  truncated: boolean
}

export interface FileToolError {
  error: string
  message: string
}
