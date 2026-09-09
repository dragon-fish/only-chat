import { z } from 'zod'

export const ModelRefSchema = z.strictObject({ provider_id: z.number().int().positive(), model_id: z.string().min(1) })
export type ModelRef = z.infer<typeof ModelRefSchema>
