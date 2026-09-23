import { describe, expect, it } from 'vitest'
import { buildImageRunInput, isChatSelectableModel, isStudioImageModel, pendingRun, stashCreatedRun, takeCreatedRun } from '@/client/lib/image-studio'
import type { ModelWithMetadata, ProviderWithInterfaces } from '@/shared/models'

const provider: ProviderWithInterfaces = {
  id: 1, user_id: 1, name: 'Gateway', has_key: true, enabled: true, models_dev_provider_id: null,
  models_dev_provider_source: null, default_image_model_id: null, default_interface_id: 10, credential_version: 1,
  interfaces: [{ id: 10, provider_id: 1, protocol: 'responses', base_url: 'https://example.com/v1', native_files: false, created_at: 0 }],
  created_at: 0,
}
const imageModel: ModelWithMetadata = {
  id: 1, provider_id: 1, model_id: 'image', interface_id: null,
  metadata: { modalities: { input: ['text', 'image'], output: ['image'] } }, metadata_override: {}, image_extra_body: {},
  catalog_matches: { operator: null, lab: null, global: null }, lab_id: null, enabled: true,
  manual_pinned: false, upstream_available: true, sort: 0,
}

describe('Image Studio client contract', () => {
  it('accepts only enabled image-output models on an OpenAI-compatible interface', () => {
    expect(isStudioImageModel(provider, imageModel)).toBe(true)
    expect(isStudioImageModel(provider, { ...imageModel, metadata: { modalities: { input: ['text'], output: ['text'] } } })).toBe(false)
    expect(isStudioImageModel({ ...provider, interfaces: [{ ...provider.interfaces[0]!, protocol: 'anthropic' }] }, imageModel)).toBe(false)
  })

  it('keeps unknown and text-capable models in chat but excludes explicit image-only models', () => {
    expect(isChatSelectableModel(imageModel)).toBe(false)
    expect(isChatSelectableModel({ ...imageModel, metadata: {} })).toBe(true)
    expect(isChatSelectableModel({ ...imageModel, metadata: { modalities: { input: ['text'], output: ['text', 'image'] } } })).toBe(true)
  })

  it('omits automatic image options and preserves custom dimensions and references', () => {
    expect(buildImageRunInput({
      model: { provider_id: 1, model_id: 'image' }, prompt: 'Otter', references: [], count: 1,
      customSize: false, width: 1024, height: 1024, quality: '', background: '', outputFormat: '',
    })).toMatchObject({ reference_attachment_ids: [], params: { count: 1, size: null } })
    expect(buildImageRunInput({
      model: { provider_id: 1, model_id: 'image' }, prompt: 'Edit', references: [7], count: 2,
      customSize: true, width: 2048, height: 2048, quality: 'high', background: 'transparent', outputFormat: 'webp',
    })).toMatchObject({
      reference_attachment_ids: [7],
      params: { count: 2, size: { width: 2048, height: 2048 }, quality: 'high', background: 'transparent', output_format: 'webp' },
    })
  })

  it('renders a submitted run before the server answers, as an edit when it carries references', () => {
    const input = (references: number[]) => buildImageRunInput({
      model: { provider_id: 1, model_id: 'image' }, conversationId: 5, prompt: 'Otter', references, count: 1,
      customSize: false, width: 1024, height: 1024, quality: '', background: '', outputFormat: '',
    })
    const first = pendingRun(input([]))
    const second = pendingRun(input([7]))

    expect(first).toMatchObject({ status: 'queued', operation: 'generate', prompt: 'Otter', conversation_id: 5, provider_id: 1 })
    expect(second).toMatchObject({ operation: 'edit', reference_attachment_ids: [7] })
    // Negative and distinct, so a placeholder can never collide with a real run or with another placeholder.
    expect(first.id).toBeLessThan(0)
    expect(second.id).not.toBe(first.id)
  })

  it('hands a created run to the next Studio instance exactly once', () => {
    const run = { ...pendingRun(buildImageRunInput({
      model: { provider_id: 1, model_id: 'image' }, prompt: 'Otter', references: [], count: 1,
      customSize: false, width: 1024, height: 1024, quality: '', background: '', outputFormat: '',
    })), id: 42, conversation_id: 9 }
    stashCreatedRun(run)

    expect(takeCreatedRun(8)).toBeUndefined()
    expect(takeCreatedRun(9)).toBe(run)
    expect(takeCreatedRun(9)).toBeUndefined()
  })
})
