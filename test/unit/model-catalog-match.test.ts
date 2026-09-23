import { describe, expect, it } from 'vitest'
import { matchCatalogModel, matchProviderByEndpoints } from '@/server/plugins/model-catalog/match'
import { parseModelCatalog, type CatalogProviderIndex } from '@/server/plugins/model-catalog/types'

const providerIndex = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', api: 'https://api.deepseek.com' },
  first: { id: 'first', name: 'First', api: 'https://gateway.example/first/' },
  second: { id: 'second', name: 'Second', api: 'https://gateway.example/second' },
} satisfies CatalogProviderIndex

const catalog = parseModelCatalog({
  providers: {
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      api: 'https://api.deepseek.com',
      models: {
        'deepseek-v4-flash': {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash on DeepSeek',
          reasoning_options: [{ type: 'toggle' }],
        },
      },
    },
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      api: 'https://openrouter.ai/api/v1',
      models: {
        'deepseek/deepseek-v4-flash': {
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash on OpenRouter',
        },
      },
    },
  },
  models: {
    'deepseek/deepseek-v4-flash': {
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
    },
    'alpha/shared-model': { id: 'alpha/shared-model', name: 'Shared Alpha' },
    'beta/shared-model': { id: 'beta/shared-model', name: 'Shared Beta' },
  },
})

describe('catalog parsing', () => {
  it('accepts and retains unknown upstream fields around validated catalog fields', () => {
    const parsed = parseModelCatalog({
      future_envelope: { revision: 2 },
      providers: {
        sample: {
          id: 'sample',
          name: 'Sample',
          future_provider_field: true,
          models: {
            model: {
              id: 'model',
              name: 'Model',
              provider: { npm: '@ai-sdk/openai-compatible' },
              experimental: { modes: { fast: {} } },
              future_model_field: 'kept',
            },
          },
        },
      },
      models: {},
    })

    expect(parsed.future_envelope).toEqual({ revision: 2 })
    expect(parsed.providers.sample.future_provider_field).toBe(true)
    expect(parsed.providers.sample.models.model).toMatchObject({
      provider: { npm: '@ai-sdk/openai-compatible' },
      experimental: { modes: { fast: {} } },
      future_model_field: 'kept',
    })
  })

  it('rejects a catalog without both provider and global model maps', () => {
    expect(() => parseModelCatalog({ providers: {} })).toThrow()
    expect(() => parseModelCatalog({ models: {} })).toThrow()
  })
})

describe('matchProviderByEndpoints', () => {
  it('uses a unique normalized default endpoint before considering siblings', () => {
    expect(matchProviderByEndpoints({
      defaultInterfaceId: 1,
      interfaces: [
        { id: 1, base_url: 'https://api.deepseek.com/' },
        { id: 2, base_url: 'https://gateway.example/second' },
      ],
    }, providerIndex)).toEqual({ id: 'deepseek', source: 'endpoint' })
  })

  it('falls back to a same-origin sibling endpoint in interface order', () => {
    expect(matchProviderByEndpoints({
      defaultInterfaceId: 1,
      interfaces: [
        { id: 1, base_url: 'https://api.deepseek.com/anthropic' },
        { id: 2, base_url: 'https://api.deepseek.com/' },
      ],
    }, providerIndex)).toEqual({ id: 'deepseek', source: 'endpoint' })
  })

  it('does not use matching siblings from another origin', () => {
    expect(matchProviderByEndpoints({
      defaultInterfaceId: 1,
      interfaces: [
        { id: 1, base_url: 'https://proxy.example/v1' },
        { id: 2, base_url: 'https://api.deepseek.com/' },
      ],
    }, providerIndex)).toEqual({ id: null, source: 'endpoint' })
  })

  it('returns no association and a warning when same-origin siblings conflict', () => {
    const result = matchProviderByEndpoints({
      defaultInterfaceId: 1,
      interfaces: [
        { id: 1, base_url: 'https://gateway.example/custom' },
        { id: 2, base_url: 'https://gateway.example/first' },
        { id: 3, base_url: 'https://gateway.example/second/' },
      ],
    }, providerIndex)

    expect(result).toMatchObject({ id: null, source: 'endpoint' })
    expect(result.warning).toBeDefined()
  })

  it('preserves a manual association instead of recalculating it from endpoints', () => {
    expect(matchProviderByEndpoints({
      defaultInterfaceId: 1,
      interfaces: [{ id: 1, base_url: 'https://api.deepseek.com' }],
      modelsDevProviderId: 'chosen-by-user',
      modelsDevProviderSource: 'manual',
    }, providerIndex)).toEqual({ id: 'chosen-by-user', source: 'manual' })
  })

  it('returns no association when the default interface or endpoint has no match', () => {
    expect(matchProviderByEndpoints({
      defaultInterfaceId: 99,
      interfaces: [{ id: 1, base_url: 'https://unknown.example/v1' }],
    }, providerIndex)).toEqual({ id: null, source: 'endpoint' })

    expect(matchProviderByEndpoints({
      defaultInterfaceId: 1,
      interfaces: [{ id: 1, base_url: 'https://unknown.example/v1' }],
    }, providerIndex)).toEqual({ id: null, source: 'endpoint' })
  })
})

describe('matchCatalogModel', () => {
  it('matches an operator-provider model by exact ID', () => {
    const result = matchCatalogModel({ providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash', catalog })

    expect(result.operatorProvider).toMatchObject({
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      kind: 'exact',
    })
    expect(result.labProvider).toBeNull()
  })

  it('matches one unique operator-provider basename when only one side has a slash', () => {
    const result = matchCatalogModel({ providerId: 'deepseek', modelId: 'vendor/deepseek-v4-flash', catalog })

    expect(result.operatorProvider).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      kind: 'basename',
    })
  })

  it('uses an exact Lab prefix only after the operator provider misses', () => {
    const result = matchCatalogModel({ providerId: null, modelId: 'deepseek/deepseek-v4-flash', catalog })

    expect(result.labProvider).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      kind: 'exact',
    })
  })

  it('allows a unique basename inside the exact-prefix Lab provider', () => {
    const result = matchCatalogModel({ providerId: null, modelId: 'deepseek/vendor/deepseek-v4-flash', catalog })

    expect(result.labProvider).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
      kind: 'basename',
    })
  })

  it('matches global models by exact ID and then by one-sided basename', () => {
    expect(matchCatalogModel({ providerId: null, modelId: 'deepseek/deepseek-v4-flash', catalog }).globalModel)
      .toMatchObject({ providerId: 'deepseek', modelId: 'deepseek/deepseek-v4-flash', kind: 'exact' })

    expect(matchCatalogModel({ providerId: null, modelId: 'deepseek-v4-flash', catalog }).globalModel)
      .toMatchObject({ providerId: 'deepseek', modelId: 'deepseek/deepseek-v4-flash', kind: 'basename' })
  })

  it('does not invoke the Lab provider fallback without an exact Lab prefix', () => {
    const result = matchCatalogModel({ providerId: null, modelId: 'deepseek-v4-flash', catalog })

    expect(result.labProvider).toBeNull()
    expect(result.globalModel).toMatchObject({ modelId: 'deepseek/deepseek-v4-flash', kind: 'basename' })
  })

  it('does not basename-match across two different known Lab prefixes', () => {
    const result = matchCatalogModel({ providerId: null, modelId: 'alpha/deepseek-v4-flash', catalog })

    expect(result.labProvider).toBeNull()
    expect(result.globalModel).toBeNull()
  })

  it('strips a gateway prefix that is not a known Lab before matching the remainder', () => {
    expect(matchCatalogModel({ providerId: null, modelId: 'gateway/deepseek-v4-flash', catalog })).toMatchObject({
      globalModel: { providerId: 'deepseek', modelId: 'deepseek/deepseek-v4-flash', kind: 'basename' },
      labId: 'deepseek',
    })

    expect(matchCatalogModel({ providerId: null, modelId: 'gateway/deepseek/deepseek-v4-flash', catalog }).globalModel)
      .toMatchObject({ modelId: 'deepseek/deepseek-v4-flash', kind: 'exact' })

    expect(matchCatalogModel({ providerId: 'openrouter', modelId: 'gateway/deepseek/deepseek-v4-flash', catalog }).operatorProvider)
      .toMatchObject({ modelId: 'deepseek/deepseek-v4-flash', kind: 'exact' })
  })

  it('rejects ambiguous basenames rather than choosing by record order', () => {
    expect(matchCatalogModel({ providerId: null, modelId: 'shared-model', catalog }).globalModel).toBeNull()
  })

  it('does not normalize case or punctuation while matching', () => {
    expect(matchCatalogModel({ providerId: null, modelId: 'DeepSeek_V4.Flash', catalog })).toMatchObject({
      operatorProvider: null,
      labProvider: null,
      globalModel: null,
    })
  })

  it('returns empty source matches for an unknown model', () => {
    expect(matchCatalogModel({ providerId: 'missing', modelId: 'unknown', catalog })).toMatchObject({
      operatorProvider: null,
      labProvider: null,
      globalModel: null,
    })
  })
})
