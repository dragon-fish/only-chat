import type { ImageGenerationParams } from '@/shared/artifacts'

export interface ImageReference {
  bytes: Uint8Array<ArrayBuffer>
  mime: string
  filename: string
}

export interface ImageGenerationRequest {
  modelId: string
  prompt: string
  references: ImageReference[]
  params: ImageGenerationParams
  idempotencyKey: string
  signal?: AbortSignal
}

export interface GeneratedImage {
  bytes: Uint8Array<ArrayBuffer>
  mime: string
  revisedPrompt?: string
}

export interface ScopedImagesClient {
  generate(request: ImageGenerationRequest): Promise<GeneratedImage[]>
}
