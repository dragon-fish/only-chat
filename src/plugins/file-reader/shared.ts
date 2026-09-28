import { z } from 'zod'
import type { LinesRead } from '@/shared/text-lines'

export const ReadFileInputSchema = z.strictObject({
  file: z.string().min(1).max(600)
    .describe('The file: the asset:<hex> a file in this conversation is labelled with, or a path such as /project/notes.md when workspace files are on.'),
  offset: z.number().int().min(1).optional().describe('1-based first line to return. Text only.'),
  limit: z.number().int().min(1).max(5000).optional().describe('How many lines to return. Text only.'),
})
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>

/** A page of a text asset. Workspace text answers with its own shape, which adds the version. */
export interface ReadAssetTextOutput extends LinesRead {
  file: string
}

/** Reading a file shown whole: the receipt, with the file following in a user message. */
export interface ReadDeliveredOutput {
  file: string
  mime: string
  message: string
}

export interface FileToolError {
  error: string
  message: string
}
