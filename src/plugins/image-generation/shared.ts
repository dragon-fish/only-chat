import { z } from 'zod'

export const GenerateImageInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(4000).describe('Detailed visual description of the image to generate.'),
  count: z.number().int().min(1).max(10).optional().describe('How many images to generate. Defaults to 1.'),
  size: z.strictObject({
    width: z.number().int().min(256).max(4096),
    height: z.number().int().min(256).max(4096),
  }).optional().describe('Output size in pixels. Omit to let the image model choose.'),
})
export type GenerateImageInput = z.infer<typeof GenerateImageInputSchema>

/** The immediate tool result: the images arrive later, in a task notification. */
export interface GenerateImageStarted {
  task_id: string
  status: 'started'
  count: number
  model: string
}

export interface GenerateImageError { error: string }

export type GenerateImageOutput = GenerateImageStarted | GenerateImageError
