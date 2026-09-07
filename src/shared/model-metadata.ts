import { z } from 'zod'

export const ModelModalitySchema = z.enum(['text', 'audio', 'image', 'video', 'pdf'])
export type ModelModality = z.infer<typeof ModelModalitySchema>

export const ModelModalitiesSchema = z.strictObject({
  input: z.array(ModelModalitySchema),
  output: z.array(ModelModalitySchema),
})
export type ModelModalities = z.infer<typeof ModelModalitiesSchema>

export const ModelLimitSchema = z.strictObject({
  context: z.number().int().nonnegative().optional(),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
})
export type ModelLimit = z.infer<typeof ModelLimitSchema>

const ModelCostFields = {
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  reasoning: z.number().nonnegative().optional(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
  input_audio: z.number().nonnegative().optional(),
  output_audio: z.number().nonnegative().optional(),
}

export const ModelCostSchema = z.strictObject({
  ...ModelCostFields,
  context_over_200k: z.strictObject(ModelCostFields).optional(),
  tiers: z.array(z.strictObject({
    ...ModelCostFields,
    tier: z.strictObject({
      type: z.literal('context').optional(),
      size: z.number().int().nonnegative(),
    }),
  })).optional(),
})
export type ModelCost = z.infer<typeof ModelCostSchema>

export const ReasoningOptionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('toggle') }),
  z.strictObject({
    type: z.literal('effort'),
    values: z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'default']).nullable()),
  }),
  z.strictObject({
    type: z.literal('budget_tokens'),
    min: z.number().int().min(-1).optional(),
    max: z.number().int().nonnegative().optional(),
  }).refine(value => value.min === undefined || value.max === undefined || value.min <= value.max, {
    message: 'Minimum reasoning budget cannot exceed maximum reasoning budget',
    path: ['min'],
  }),
])
export type ReasoningOption = z.infer<typeof ReasoningOptionSchema>

export const ModelLinkSchema = z.strictObject({
  label: z.string().min(1).optional(),
  url: z.string().url(),
  type: z.enum(['announcement', 'blog', 'docs', 'license', 'model_card', 'paper', 'weights', 'other']).optional(),
})
export type ModelLink = z.infer<typeof ModelLinkSchema>

export const ModelWeightsSchema = z.strictObject({
  label: z.string().min(1).optional(),
  url: z.string().url(),
  format: z.string().min(1).optional(),
  quantization: z.string().min(1).optional(),
})
export type ModelWeights = z.infer<typeof ModelWeightsSchema>

export const BenchmarkResultSchema = z.strictObject({
  name: z.string().min(1),
  score: z.union([z.number(), z.string().min(1)]),
  metric: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  dataset: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  source: z.string().url().optional(),
  date: z.string().optional(),
})
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>

/** Metadata from models.dev and user overrides. Missing fields inherit; only cost can be explicitly cleared. */
export const ModelMetadataSchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  family: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(ReasoningOptionSchema).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  modalities: ModelModalitiesSchema.optional(),
  limit: ModelLimitSchema.optional(),
  cost: ModelCostSchema.nullable().optional(),
  interleaved: z.union([z.boolean(), z.strictObject({ field: z.string().min(1) })]).optional(),
  knowledge: z.string().optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
  open_weights: z.boolean().optional(),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
  license: z.string().optional(),
  links: z.array(ModelLinkSchema).optional(),
  weights: z.array(ModelWeightsSchema).optional(),
  benchmarks: z.array(BenchmarkResultSchema).optional(),
})
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>

/** A partial, recursively mergeable user layer over catalog metadata. */
export const ModelModalitiesOverrideSchema = z.strictObject({
  input: z.array(ModelModalitySchema).optional(),
  output: z.array(ModelModalitySchema).optional(),
})

export const ModelLimitOverrideSchema = z.strictObject({
  context: z.number().int().nonnegative().optional(),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
})

const ModelCostOverrideFields = {
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  reasoning: z.number().nonnegative().optional(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
  input_audio: z.number().nonnegative().optional(),
  output_audio: z.number().nonnegative().optional(),
}

export const ModelCostOverrideSchema = z.strictObject({
  ...ModelCostOverrideFields,
  context_over_200k: z.strictObject(ModelCostOverrideFields).optional(),
  tiers: z.array(z.strictObject({
    ...ModelCostOverrideFields,
    tier: z.strictObject({
      type: z.literal('context').optional(),
      size: z.number().int().nonnegative().optional(),
    }).optional(),
  })).optional(),
})

export const ModelMetadataOverrideSchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  family: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(ReasoningOptionSchema).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  modalities: ModelModalitiesOverrideSchema.optional(),
  limit: ModelLimitOverrideSchema.optional(),
  cost: ModelCostOverrideSchema.nullable().optional(),
  interleaved: z.union([z.boolean(), z.strictObject({ field: z.string().min(1).optional() })]).optional(),
  knowledge: z.string().optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
  open_weights: z.boolean().optional(),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
  license: z.string().optional(),
  links: z.array(ModelLinkSchema).optional(),
  weights: z.array(ModelWeightsSchema).optional(),
  benchmarks: z.array(BenchmarkResultSchema).optional(),
})
export type ModelMetadataOverride = z.infer<typeof ModelMetadataOverrideSchema>

export const CatalogMatchSchema = z.strictObject({
  provider_id: z.string().min(1),
  model_id: z.string().min(1),
  kind: z.enum(['exact', 'basename']),
})
export type CatalogMatch = z.infer<typeof CatalogMatchSchema>

/** Null means this catalog source did not yield a unique model match. */
export const CatalogMatchesSchema = z.strictObject({
  operator: CatalogMatchSchema.nullable(),
  lab: CatalogMatchSchema.nullable(),
  global: CatalogMatchSchema.nullable(),
})
export type CatalogMatches = z.infer<typeof CatalogMatchesSchema>
