import type { ArtifactRunDto, CreateImageRunInput, ImageExtraBody } from '@/shared/artifacts'
import type { ModelRef } from '@/shared/model-ref'
import type { ModelListItem, ProviderWithInterfaces } from '@/shared/models'

const IMAGE_PROTOCOLS = new Set(['responses', 'chat-completions'])

export function isStudioImageModel(provider: ProviderWithInterfaces, model: ModelListItem): boolean {
  if (!provider.enabled || !model.enabled || !model.metadata.modalities?.output.includes('image')) return false
  const interfaceId = model.interface_id ?? provider.default_interface_id
  const selected = provider.interfaces.find(endpoint => endpoint.id === interfaceId)
  return selected !== undefined && IMAGE_PROTOCOLS.has(selected.protocol)
}

export function isChatSelectableModel(model: ModelListItem): boolean {
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
  extra?: ImageExtraBody
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
      ...(draft.extra && Object.keys(draft.extra).length ? { extra: { ...draft.extra } } : {}),
    },
  }
}

let nextPendingId = -1

/**
 * The row a submitted run occupies until `POST /artifact-runs/image` answers. Its id is negative so
 * it can never be mistaken for a real run — nothing may send it to the API. Only the fields Studio
 * renders are real; the provider and model names stay empty until the first poll replaces the row.
 */
export function pendingRun(input: CreateImageRunInput): ArtifactRunDto {
  return {
    id: nextPendingId--,
    user_id: 0,
    client_request_id: input.client_request_id,
    kind: 'image_generation',
    source: 'studio',
    operation: input.reference_attachment_ids.length ? 'edit' : 'generate',
    status: 'queued',
    conversation_id: input.conversation_id ?? null,
    message_id: null,
    provider_id: input.model.provider_id,
    model_id: input.model.model_id,
    provider_name: '',
    interface_protocol: '',
    model_name: '',
    prompt: input.prompt,
    params: input.params,
    error: null,
    usage: null,
    created_at: Date.now(),
    started_at: null,
    completed_at: null,
    reference_attachment_ids: input.reference_attachment_ids,
  }
}

/**
 * `/images/new` and `/images/s/:id` are different route components, so the first run of a new
 * conversation outlives the Studio instance that submitted it. The next instance takes it from here
 * instead of showing a skeleton until its own fetch returns.
 */
const createdRuns = new Map<number, ArtifactRunDto>()

export function stashCreatedRun(run: ArtifactRunDto & { conversation_id: number }): void {
  createdRuns.set(run.conversation_id, run)
}

export function takeCreatedRun(conversationId: number): ArtifactRunDto | undefined {
  const run = createdRuns.get(conversationId)
  createdRuns.delete(conversationId)
  return run
}
