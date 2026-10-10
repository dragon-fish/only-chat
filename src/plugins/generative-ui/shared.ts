import { z } from 'zod'

export const GENERATIVE_UI_PLUGIN_ID = 'generative_ui' as const
export const RENDER_UI_TOOL_ID = 'render_ui' as const

export const RenderUiInputSchema = z.object({
  code: z.string().min(1).describe('A complete OpenUI Lang program whose first statement is `root = Stack([...])`.'),
})
export type RenderUiInput = z.infer<typeof RenderUiInputSchema>

/**
 * `invalid` means the user saw nothing: the card hides a program that did not parse rather than
 * render half of it, so the model must call again with a fixed program.
 */
export const RenderUiResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('rendered'), message: z.string() }),
  z.object({ status: z.literal('invalid'), message: z.string(), errors: z.array(z.string()) }),
])
export type RenderUiResult = z.infer<typeof RenderUiResultSchema>
