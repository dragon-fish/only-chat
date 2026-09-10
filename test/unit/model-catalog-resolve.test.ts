import { describe, expect, it } from 'vitest'
import { materializeModelMetadata, resolveModelMetadata } from '@/server/plugins/model-catalog/resolve'
import { parseModelCatalog } from '@/server/plugins/model-catalog/types'
import { ModelMetadataSchema } from '@/shared/model-metadata'

const catalog = parseModelCatalog({
  providers: {
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      api: 'https://api.deepseek.com',
      models: {
        'deepseek-v4-flash': {
          id: 'deepseek-v4-flash',
          name: 'Provider-specific name',
          reasoning: false,
          reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
          tool_call: false,
          interleaved: { field: 'reasoning_content' },
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 1_000_000, output: 384_000 },
          cost: { input: 0.14, output: 0.28 },
          status: 'deprecated',
          provider: { npm: '@ai-sdk/openai-compatible' },
          experimental: { modes: { fast: {} } },
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
          name: 'OpenRouter DeepSeek V4 Flash',
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 250_000, output: 16_000 },
          cost: { input: 2, output: 3 },
        },
      },
    },
  },
  models: {
    'deepseek/deepseek-v4-flash': {
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      description: 'Provider-agnostic facts',
      reasoning: true,
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text', 'image'] },
      limit: { context: 128_000, output: 8_000 },
      status: 'beta',
    },
    'deepseek/other-model': {
      id: 'deepseek/other-model',
      name: 'Other DeepSeek Model',
    },
    'acme-labs/model': {
      id: 'acme-labs/model',
      name: 'Acme Model',
    },
  },
})

describe('resolveModelMetadata', () => {
  it('keeps provider-reported image modalities across catalog materialization while user overrides remain final', () => {
    const resolved = resolveModelMetadata({
      providerId: 'deepseek', modelId: 'deepseek-v4-flash', catalog,
      providerMetadata: { name: 'Provider response', modalities: { input: ['text', 'image'], output: ['image'] } },
      metadataOverride: { name: 'My name' },
    })
    expect(resolved.metadata).toMatchObject({
      name: 'My name', modalities: { input: ['text', 'image'], output: ['image'] },
    })
  })

  it('uses complete operator metadata, including operator cost and limits', () => {
    const resolved = resolveModelMetadata({
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      metadataOverride: {},
      catalog,
    })

    expect(resolved.metadata).toMatchObject({
      name: 'OpenRouter DeepSeek V4 Flash',
      limit: { context: 250_000, output: 16_000 },
      cost: { input: 2, output: 3 },
    })
    expect(resolved.matches.operator).toEqual({
      provider_id: 'openrouter',
      model_id: 'deepseek/deepseek-v4-flash',
      kind: 'exact',
    })
  })

  it('adds only the safe Lab-provider subset over global model facts', () => {
    const resolved = resolveModelMetadata({
      providerId: null,
      modelId: 'deepseek/deepseek-v4-flash',
      metadataOverride: {},
      catalog,
    })

    expect(resolved.metadata).toEqual({
      name: 'DeepSeek V4 Flash',
      description: 'Provider-agnostic facts',
      reasoning: true,
      reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
      tool_call: true,
      interleaved: { field: 'reasoning_content' },
      modalities: { input: ['text'], output: ['text'] },
      limit: { context: 128_000, output: 8_000 },
      status: 'beta',
    })
    expect(resolved.matches).toEqual({
      operator: null,
      lab: { provider_id: 'deepseek', model_id: 'deepseek-v4-flash', kind: 'exact' },
      global: { provider_id: 'deepseek', model_id: 'deepseek/deepseek-v4-flash', kind: 'exact' },
    })
  })

  it('lets explicit false overrides replace inherited booleans', () => {
    const resolved = resolveModelMetadata({
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      metadataOverride: { reasoning: false, tool_call: false },
      catalog,
    })

    expect(resolved.metadata.reasoning).toBe(false)
    expect(resolved.metadata.tool_call).toBe(false)
  })

  it('recursively merges nested overrides and preserves explicit zero', () => {
    const resolved = resolveModelMetadata({
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      metadataOverride: {
        cost: { input: 0 },
        limit: { output: 0 },
        modalities: { input: [] },
      },
      catalog,
    })

    expect(resolved.metadata.cost).toEqual({ input: 0, output: 3 })
    expect(resolved.metadata.limit).toEqual({ context: 250_000, output: 0 })
    expect(resolved.metadata.modalities).toEqual({ input: [], output: ['text'] })
  })

  it('lets explicit null clear inherited nullable metadata', () => {
    const resolved = resolveModelMetadata({
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      metadataOverride: { cost: null },
      catalog,
    })

    expect(resolved.metadata.cost).toBeNull()
  })

  it('fills conservative modality siblings when a partial override has no catalog base', () => {
    const resolved = resolveModelMetadata({
      providerId: null,
      modelId: 'unknown-model',
      metadataOverride: { modalities: { input: ['image'] } },
      catalog,
    })

    expect(resolved.metadata.modalities).toEqual({ input: ['image'], output: ['text'] })
    expect(ModelMetadataSchema.parse(resolved.metadata)).toEqual(resolved.metadata)
  })

  it('treats an empty nested override as inheritance when there is no lower value', () => {
    const resolved = resolveModelMetadata({
      providerId: null,
      modelId: 'unknown-model',
      metadataOverride: { interleaved: {} },
      catalog,
    })

    expect(resolved.metadata.interleaved).toBeUndefined()
    expect(ModelMetadataSchema.parse(resolved.metadata)).toEqual(resolved.metadata)
  })

  it('uses an unmatched exact Lab prefix for grouping only', () => {
    const resolved = resolveModelMetadata({
      providerId: null,
      modelId: 'deepseek/unlisted-model',
      metadataOverride: { name: 'My private alias' },
      catalog,
    })

    expect(resolved.metadata).toEqual({
      name: 'My private alias',
      modalities: { input: ['text'], output: ['text'] },
    })
    expect(resolved.matches).toEqual({ operator: null, lab: null, global: null })
    expect(resolved.labId).toBe('deepseek')
    expect(resolved.labName).toBe('DeepSeek')
  })

  it('derives a readable Lab name when a global Lab has no provider record', () => {
    const resolved = resolveModelMetadata({
      providerId: null,
      modelId: 'acme-labs/model',
      metadataOverride: {},
      catalog,
    })

    expect(resolved.labId).toBe('acme-labs')
    expect(resolved.labName).toBe('Acme Labs')
  })

  it('does not mutate catalog records or override objects', () => {
    const providerModel = catalog.providers.openrouter.models['deepseek/deepseek-v4-flash']
    const metadataOverride = { limit: { output: 0 } }

    resolveModelMetadata({
      providerId: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      metadataOverride,
      catalog,
    })

    expect(providerModel.limit).toEqual({ context: 250_000, output: 16_000 })
    expect(metadataOverride).toEqual({ limit: { output: 0 } })
  })
})

describe('materializeModelMetadata', () => {
  it('derives indexed facts and normalized search text from effective metadata', () => {
    expect(materializeModelMetadata({
      name: '  Vision   Pro  ',
      reasoning: true,
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['image'] },
      limit: { context: 0, output: 0 },
    }, 'Vendor/Model', 'Deep Seek')).toEqual({
      supports_image_input: true,
      supports_image_output: true,
      supports_reasoning: true,
      supports_tools: true,
      context_limit: 0,
      output_limit: 0,
    })
  })

  it('does not infer filter capabilities from suggestive names or model IDs', () => {
    expect(materializeModelMetadata({ name: 'Vision Reasoning Tool Model' }, 'vision-reasoning-tools-image', null)).toMatchObject({
      supports_image_input: false,
      supports_image_output: false,
      supports_reasoning: false,
      supports_tools: false,
      context_limit: null,
      output_limit: null,
    })
  })
})
