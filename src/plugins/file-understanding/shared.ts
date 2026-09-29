import { z } from 'zod'
import type { StepUsage } from '@/shared/models'

export { ANALYZE_FILE_TOOL_ID, FILE_UNDERSTANDING_PLUGIN_ID } from '@/shared/plugins'

export const AnalyzeFileInputSchema = z.strictObject({
  file: z.string().min(1).max(600)
    .describe('The file: the asset:<hex> a file in this conversation is labelled with, or a workspace path such as /project/report.pdf when workspace files are on.'),
  question: z.string().min(1).optional()
    .describe('What you want to know about the file. Omit it for a complete, detailed description.'),
})
export type AnalyzeFileInput = z.infer<typeof AnalyzeFileInputSchema>

/** Tool results are persisted, so this is part of the wire format. */
export interface AnalyzeFileOutput {
  file: string
  /** What the person called the file, for a card to show; null for one that was never named (a pasted or generated image). */
  name: string | null
  mime: string
  /** The service model that read the file, named as the person set it up. */
  model: { provider_id: number, provider_name: string, model_id: string }
  /** What the analysis cost. Its own model's tokens, never folded into the reply's usage. */
  usage: StepUsage
  text: string
  /** The analysis stopped at the service model's output limit, so `text` is incomplete. */
  truncated: boolean
}

export interface FileToolError {
  error: string
  message: string
}
