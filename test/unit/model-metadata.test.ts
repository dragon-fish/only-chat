import { describe, expect, it } from 'vitest'
import {
  CatalogMatchesSchema,
  ModelMetadataOverrideSchema,
  ModelMetadataSchema,
} from '@/shared/model-metadata'

describe('model metadata schemas', () => {
  it('preserves explicit false and zero overrides', () => {
    expect(ModelMetadataOverrideSchema.parse({
      reasoning: false,
      cost: { input: 0, tiers: [{ tier: { size: 200_000 } }] },
    })).toEqual({
      reasoning: false,
      cost: { input: 0, tiers: [{ tier: { size: 200_000 } }] },
    })
  })

  it('allows an explicit null to clear nullable inherited metadata', () => {
    expect(ModelMetadataOverrideSchema.parse({ cost: null })).toEqual({ cost: null })
  })

  it('allows nested override objects to inherit omitted sibling fields', () => {
    expect(ModelMetadataOverrideSchema.parse({
      modalities: { input: ['image'] },
      limit: { context: 262144 },
      interleaved: {},
    })).toEqual({
      modalities: { input: ['image'] },
      limit: { context: 262144 },
      interleaved: {},
    })
  })

  it('parses catalog-aligned nested metadata', () => {
    expect(ModelMetadataSchema.parse({
      name: 'Example',
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 262144, output: 16384 },
      reasoning_options: [{ type: 'effort', values: [null, 'low', 'high'] }],
      links: [{ label: 'Docs', type: 'docs', url: 'https://example.test/docs' }],
      weights: [{ format: 'safetensors', url: 'https://example.test/model' }],
      benchmarks: [{ name: 'MMLU', score: 88.2, source: 'https://example.test/mmlu' }],
      interleaved: { field: 'reasoning_content' },
    })).toMatchObject({
      modalities: { input: ['text', 'image'] },
      limit: { context: 262144 },
      interleaved: { field: 'reasoning_content' },
    })
  })

  it('records nullable catalog matches by source and match kind', () => {
    expect(CatalogMatchesSchema.parse({
      operator: { provider_id: 'openai', model_id: 'gpt-5', kind: 'exact' },
      lab: null,
      global: { provider_id: 'openai', model_id: 'gpt-5', kind: 'basename' },
    })).toMatchObject({ operator: { kind: 'exact' }, lab: null, global: { kind: 'basename' } })
  })
})
