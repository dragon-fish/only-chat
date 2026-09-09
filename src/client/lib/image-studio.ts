import type { CreateImageRunInput } from '@/shared/artifacts'
import type { ModelRef } from '@/shared/model-ref'
import type { ModelWithMetadata, ProviderWithInterfaces } from '@/shared/models'

const IMAGE_PROTOCOLS = new Set(['responses', 'chat-completions'])

export function isStudioImageModel(provider: ProviderWithInterfaces, model: ModelWithMetadata): boolean {
  if (!provider.enabled || !model.enabled || !model.metadata.modalities?.output.includes('image')) return false
  const interfaceId = model.interface_id ?? provider.default_interface_id
  const selected = provider.interfaces.find(endpoint => endpoint.id === interfaceId)
  return selected !== undefined && IMAGE_PROTOCOLS.has(selected.protocol)
}

export function isChatSelectableModel(model: ModelWithMetadata): boolean {
  const output = model.metadata.modalities?.output
  return output === undefined || output.includes('text') || !output.includes('image')
}

interface ImageDraft {
  model: ModelRef
  conversationId?: number
  prompt: string
  references: number[]
  count: number
  customSize: boolean
  width: number
  height: number
  quality: string
  background: '' | 'transparent' | 'opaque'
  outputFormat: '' | 'png' | 'webp' | 'jpeg'
}

export function buildImageRunInput(draft: ImageDraft): CreateImageRunInput {
  const quality = draft.quality.trim()
  return {
    client_request_id: crypto.randomUUID(),
    ...(draft.conversationId === undefined ? {} : { conversation_id: draft.conversationId }),
    model: draft.model,
    prompt: draft.prompt,
    reference_attachment_ids: [...draft.references],
    params: {
      count: draft.count,
      size: draft.customSize ? { width: draft.width, height: draft.height } : null,
      ...(quality ? { quality } : {}),
      ...(draft.background ? { background: draft.background } : {}),
      ...(draft.outputFormat ? { output_format: draft.outputFormat } : {}),
    },
  }
}
