import { z } from 'zod'
import { ModelMetadataSchema } from '@/shared/model-metadata'

/**
 * The upstream catalog grows independently from this application. Validate the
 * fields we consume while retaining unknown fields in cached catalog shards.
 */
export const CatalogModelSchema = ModelMetadataSchema.extend({
  id: z.string().min(1),
  provider: z.unknown().optional(),
  experimental: z.unknown().optional(),
}).passthrough()
export type CatalogModel = z.infer<typeof CatalogModelSchema>

export const CatalogProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  api: z.string().min(1).optional(),
  npm: z.string().min(1).optional(),
  env: z.array(z.string()).optional(),
  doc: z.string().min(1).optional(),
  models: z.record(z.string(), CatalogModelSchema),
}).passthrough()
export type CatalogProvider = z.infer<typeof CatalogProviderSchema>

export const ModelCatalogSchema = z.object({
  providers: z.record(z.string(), CatalogProviderSchema),
  models: z.record(z.string(), CatalogModelSchema),
}).passthrough()
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>

export interface CatalogProviderIndexEntry {
  id: string
  name: string
  api?: string
  [key: string]: unknown
}

export type CatalogProviderIndex = Readonly<Record<string, CatalogProviderIndexEntry>>

export function parseModelCatalog(input: unknown): ModelCatalog {
  return ModelCatalogSchema.parse(input)
}
