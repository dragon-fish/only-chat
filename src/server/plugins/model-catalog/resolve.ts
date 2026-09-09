import {
  ModelMetadataSchema,
  type CatalogMatch,
  type CatalogMatches,
  type ModelMetadata,
  type ModelMetadataOverride,
} from '@/shared/model-metadata'
import { matchCatalogModel, type CatalogModelHit } from './match'
import type { CatalogModel, ModelCatalog } from './types'

const MODEL_METADATA_FIELDS = [
  'name',
  'description',
  'family',
  'attachment',
  'reasoning',
  'reasoning_options',
  'tool_call',
  'structured_output',
  'temperature',
  'modalities',
  'limit',
  'cost',
  'interleaved',
  'knowledge',
  'release_date',
  'last_updated',
  'open_weights',
  'status',
  'license',
  'links',
  'weights',
  'benchmarks',
] as const satisfies readonly (keyof ModelMetadata)[]

const LAB_PROVIDER_FIELDS = ['reasoning_options', 'interleaved', 'modalities'] as const satisfies readonly (keyof ModelMetadata)[]

const CONSERVATIVE_MODEL_METADATA: ModelMetadata = {
  modalities: { input: ['text'], output: ['text'] },
}

export interface ResolvedModelMetadata {
  metadata: ModelMetadata
  matches: CatalogMatches
  labId: string | null
  labName: string | null
}

export interface MaterializedModelMetadata {
  search_name: string
  supports_image_input: boolean
  supports_image_output: boolean
  supports_reasoning: boolean
  supports_tools: boolean
  context_limit: number | null
  output_limit: number | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)])) as T
}

function mergeObject(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = cloneValue(base)
  for (const [key, overlayValue] of Object.entries(overlay)) {
    if (overlayValue === undefined) continue
    const baseValue = result[key]
    if (isPlainObject(overlayValue)) {
      const baseObject = isPlainObject(baseValue) ? baseValue : {}
      const merged = mergeObject(baseObject, overlayValue)
      if (Object.keys(merged).length === 0 && !isPlainObject(baseValue)) continue
      result[key] = merged
    }
    else {
      result[key] = cloneValue(overlayValue)
    }
  }
  return result
}

function mergeMetadata(...layers: ReadonlyArray<Partial<ModelMetadata> | ModelMetadataOverride>): ModelMetadata {
  const merged = layers.reduce<Record<string, unknown>>(
    (resolved, layer) => mergeObject(resolved, layer as Record<string, unknown>),
    {},
  )
  return ModelMetadataSchema.parse(merged)
}

function projectFields<const Keys extends readonly (keyof ModelMetadata)[]>(
  model: CatalogModel,
  fields: Keys,
): Pick<ModelMetadata, Keys[number]> {
  const projected: Partial<ModelMetadata> = {}
  for (const field of fields) {
    const value = model[field]
    if (value !== undefined) Object.assign(projected, { [field]: cloneValue(value) })
  }
  return projected as Pick<ModelMetadata, Keys[number]>
}

function catalogMetadata(model: CatalogModel): ModelMetadata {
  return projectFields(model, MODEL_METADATA_FIELDS)
}

export function labProviderFallback(model: CatalogModel): ModelMetadata {
  return projectFields(model, LAB_PROVIDER_FIELDS)
}

function catalogMatch(hit: CatalogModelHit | null): CatalogMatch | null {
  return hit === null
    ? null
    : { provider_id: hit.providerId, model_id: hit.modelId, kind: hit.kind }
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]+/u)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function resolveModelMetadata({
  providerId,
  modelId,
  metadataOverride = {},
  providerMetadata = {},
  catalog,
}: {
  providerId: string | null
  modelId: string
  metadataOverride?: ModelMetadataOverride
  providerMetadata?: ModelMetadata
  catalog: ModelCatalog
}): ResolvedModelMetadata {
  const matched = matchCatalogModel({ providerId, modelId, catalog })
  const metadata = matched.operatorProvider
    ? mergeMetadata(CONSERVATIVE_MODEL_METADATA, catalogMetadata(matched.operatorProvider.model), providerMetadata, metadataOverride)
    : mergeMetadata(
        CONSERVATIVE_MODEL_METADATA,
        matched.globalModel ? catalogMetadata(matched.globalModel.model) : {},
        matched.labProvider ? labProviderFallback(matched.labProvider.model) : {},
        providerMetadata,
        metadataOverride,
      )
  const labName = matched.labId === null
    ? null
    : catalog.providers[matched.labId]?.name ?? titleFromId(matched.labId)

  return {
    metadata,
    matches: {
      operator: catalogMatch(matched.operatorProvider),
      lab: catalogMatch(matched.labProvider),
      global: catalogMatch(matched.globalModel),
    },
    labId: matched.labId,
    labName,
  }
}

function normalizeSearchPart(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

export function materializeModelMetadata(
  metadata: ModelMetadata,
  modelId: string,
  labName: string | null,
): MaterializedModelMetadata {
  return {
    search_name: [metadata.name, modelId, labName]
      .filter((value): value is string => value !== null && value !== undefined && normalizeSearchPart(value) !== '')
      .map(normalizeSearchPart)
      .join(' ')
      .toLowerCase(),
    supports_image_input: metadata.modalities?.input.includes('image') ?? false,
    supports_image_output: metadata.modalities?.output.includes('image') ?? false,
    supports_reasoning: metadata.reasoning === true,
    supports_tools: metadata.tool_call === true,
    context_limit: metadata.limit?.context ?? null,
    output_limit: metadata.limit?.output ?? null,
  }
}
