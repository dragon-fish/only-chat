import { z } from 'zod'

export const GenerateImageInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(4000).describe('Detailed visual description of the image to generate.'),
  count: z.number().int().min(1).max(10).optional().describe('How many images to generate. Defaults to 1.'),
  size: z.strictObject({
    width: z.number().int().min(256).max(4096),
    height: z.number().int().min(256).max(4096),
  }).optional().describe('Output size in pixels. Omit to let the image model choose.'),
  reference_images: z.array(z.string().min(1)).min(1).max(10).optional()
    .describe('Images to edit or draw from, as file references such as asset:3f9a2c1e — the asset: in the label of an image the user sent, a generated image, or a task notification.'),
})
export type GenerateImageInput = z.infer<typeof GenerateImageInputSchema>

/** The immediate tool result: the images arrive later, in a task notification. */
export const GenerateImageStartedSchema = z.object({
  task_id: z.string().regex(/^image_run:\d+$/),
  status: z.literal('started'),
  count: z.number().int(),
  model: z.string(),
})
export type GenerateImageStarted = z.infer<typeof GenerateImageStartedSchema>

/** `code` is set for a reference that could not be used, with the file-reference error code. */
export const GenerateImageErrorSchema = z.object({ error: z.string(), code: z.string().optional() })
export type GenerateImageError = z.infer<typeof GenerateImageErrorSchema>

export type GenerateImageOutput = GenerateImageStarted | GenerateImageError

/** The artifact run behind an `image_run:<id>` task id. */
export function runIdOf(taskId: string): number | null {
  const match = /^image_run:(\d+)$/.exec(taskId)
  return match ? Number(match[1]) : null
}
