import { z } from 'zod'

export const CurrentTimeInputSchema = z.object({
  timezone: z.string().optional()
    .describe('IANA 时区名，如 Asia/Shanghai、Europe/London。省略则使用 UTC'),
})

export const CurrentTimeOutputSchema = z.object({
  timezone: z.string(),
  /** Machine-readable instant, identical across every timezone in one parallel batch. */
  iso: z.string(),
  /** Rendered in the requested zone, which is the part the model is actually being asked for. */
  local: z.string(),
  weekday: z.string(),
})

export const CurrentTimeErrorSchema = z.object({ error: z.string() })

export type CurrentTimeInput = z.infer<typeof CurrentTimeInputSchema>
export type CurrentTimeOutput = z.infer<typeof CurrentTimeOutputSchema>
