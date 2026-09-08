import type { CatalogMatch } from '@/shared/model-metadata'
import type {
  CatalogModel,
  CatalogProviderIndex,
  ModelCatalog,
} from './types'

export interface ProviderEndpoint {
  id: number
  base_url: string
}

export interface ProviderEndpointMatchInput {
  defaultInterfaceId: number | null
  interfaces: readonly ProviderEndpoint[]
  modelsDevProviderId?: string | null
  modelsDevProviderSource?: 'manual' | 'endpoint' | null
}

export interface ProviderEndpointMatch {
  id: string | null
  source: 'manual' | 'endpoint'
  warning?: string
}

export interface CatalogModelHit {
  providerId: string
  modelId: string
  kind: CatalogMatch['kind']
  model: CatalogModel
}

export interface CatalogModelMatchResult {
  operatorProvider: CatalogModelHit | null
  labProvider: CatalogModelHit | null
  globalModel: CatalogModelHit | null
  labId: string | null
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/u, '')
}

function matchingProviderIds(endpoint: string, providers: CatalogProviderIndex): string[] {
  const normalizedEndpoint = normalizeEndpoint(endpoint)
  return [...new Set(Object.values(providers)
    .filter(provider => provider.api !== undefined && normalizeEndpoint(provider.api) === normalizedEndpoint)
    .map(provider => provider.id))]
}

function endpointOrigin(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin
  }
  catch {
    return null
  }
}

/**
 * Preserves manual choices. Automatic matching checks the default endpoint
 * first, then only configured siblings whose URL origin is identical.
 */
export function matchProviderByEndpoints(
  input: ProviderEndpointMatchInput,
  providers: CatalogProviderIndex,
): ProviderEndpointMatch {
  if (input.modelsDevProviderSource === 'manual') {
    return { id: input.modelsDevProviderId ?? null, source: 'manual' }
  }

  const defaultInterface = input.interfaces.find(entry => entry.id === input.defaultInterfaceId)
  if (!defaultInterface) return { id: null, source: 'endpoint' }

  const defaultMatches = matchingProviderIds(defaultInterface.base_url, providers)
  if (defaultMatches.length === 1) return { id: defaultMatches[0], source: 'endpoint' }
  if (defaultMatches.length > 1) {
    return {
      id: null,
      source: 'endpoint',
      warning: 'The default endpoint matches multiple catalog providers.',
    }
  }

  const defaultOrigin = endpointOrigin(defaultInterface.base_url)
  if (defaultOrigin === null) return { id: null, source: 'endpoint' }

  const siblingMatches: string[] = []
  for (const sibling of input.interfaces) {
    if (sibling.id === defaultInterface.id || endpointOrigin(sibling.base_url) !== defaultOrigin) continue
    siblingMatches.push(...matchingProviderIds(sibling.base_url, providers))
  }

  const uniqueSiblingMatches = [...new Set(siblingMatches)]
  if (uniqueSiblingMatches.length === 1) return { id: uniqueSiblingMatches[0], source: 'endpoint' }
  if (uniqueSiblingMatches.length > 1) {
    return {
      id: null,
      source: 'endpoint',
      warning: 'Same-origin endpoints match different catalog providers.',
    }
  }
  return { id: null, source: 'endpoint' }
}

interface ModelRecordHit {
  modelId: string
  kind: CatalogMatch['kind']
  model: CatalogModel
}

function basename(modelId: string): string {
  return modelId.slice(modelId.lastIndexOf('/') + 1)
}

function matchModelRecord(modelId: string, models: Readonly<Record<string, CatalogModel>>): ModelRecordHit | null {
  if (Object.prototype.hasOwnProperty.call(models, modelId)) {
    return { modelId, kind: 'exact', model: models[modelId] }
  }

  const inputHasSlash = modelId.includes('/')
  const matches = Object.entries(models).filter(([candidateId]) => {
    if (candidateId.includes('/') === inputHasSlash) return false
    return basename(candidateId) === basename(modelId)
  })
  if (matches.length !== 1) return null

  const [matchedModelId, model] = matches[0]
  return { modelId: matchedModelId, kind: 'basename', model }
}

function labIdFromGlobalModelId(modelId: string): string | null {
  const separator = modelId.indexOf('/')
  return separator > 0 ? modelId.slice(0, separator) : null
}

function toCatalogModelHit(providerId: string, hit: ModelRecordHit | null): CatalogModelHit | null {
  return hit === null ? null : { providerId, ...hit }
}

/** Match each explainable catalog source without applying any metadata. */
export function matchCatalogModel({ providerId, modelId, catalog }: {
  providerId: string | null
  modelId: string
  catalog: ModelCatalog
}): CatalogModelMatchResult {
  const operatorProvider = providerId === null
    ? null
    : toCatalogModelHit(providerId, matchModelRecord(modelId, catalog.providers[providerId]?.models ?? {}))

  const knownLabIds = new Set(Object.keys(catalog.models)
    .map(labIdFromGlobalModelId)
    .filter((id): id is string => id !== null))

  const separator = modelId.indexOf('/')
  const prefixedLabId = separator > 0 ? modelId.slice(0, separator) : null
  let labProvider: CatalogModelHit | null = null
  if (operatorProvider === null
    && prefixedLabId !== null
    && knownLabIds.has(prefixedLabId)
    && catalog.providers[prefixedLabId]) {
    const modelIdWithoutLab = modelId.slice(separator + 1)
    labProvider = toCatalogModelHit(
      prefixedLabId,
      matchModelAndKeepExactPrefix(modelIdWithoutLab, catalog.providers[prefixedLabId].models),
    )
  }

  const globalRecordHit = matchModelRecord(modelId, catalog.models)
  const globalLabId = globalRecordHit === null ? null : labIdFromGlobalModelId(globalRecordHit.modelId)
  const globalModel = globalRecordHit === null
    ? null
    : toCatalogModelHit(globalLabId ?? globalRecordHit.modelId, globalRecordHit)

  return {
    operatorProvider,
    labProvider,
    globalModel,
    labId: globalLabId ?? labProvider?.providerId ?? (prefixedLabId !== null && knownLabIds.has(prefixedLabId) ? prefixedLabId : null),
  }
}

/** The caller has already proven the prefix exactly; only the remaining ID may use basename fallback. */
function matchModelAndKeepExactPrefix(
  modelIdWithoutLab: string,
  models: Readonly<Record<string, CatalogModel>>,
): ModelRecordHit | null {
  return matchModelRecord(modelIdWithoutLab, models)
}
