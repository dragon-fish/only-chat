import { z } from 'zod'
import type { GeneratedImage, ImageGenerationRequest, ScopedImagesClient } from './types'

const ResponseSchema = z.object({
  data: z.array(z.object({
    b64_json: z.string().optional(),
    url: z.string().url().optional(),
    revised_prompt: z.string().optional(),
  }).refine(value => value.b64_json !== undefined || value.url !== undefined, 'image data missing')).min(1),
})

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index)
  return bytes
}

function requestedMime(request: ImageGenerationRequest): string {
  if (request.params.output_format === 'webp') return 'image/webp'
  if (request.params.output_format === 'jpeg') return 'image/jpeg'
  return 'image/png'
}

function appendOptions(body: FormData, request: ImageGenerationRequest): void {
  const { params } = request
  body.set('n', String(params.count))
  if (params.size) body.set('size', `${params.size.width}x${params.size.height}`)
  if (params.quality) body.set('quality', params.quality)
  if (params.background) body.set('background', params.background)
  if (params.output_format) body.set('output_format', params.output_format)
}

async function readResponse(response: Response, request: ImageGenerationRequest): Promise<GeneratedImage[]> {
  if (!response.ok) throw new Error(`Images API request failed: ${response.status}`)
  const parsed = ResponseSchema.parse(await response.json())
  return Promise.all(parsed.data.map(async (item) => {
    let bytes: Uint8Array<ArrayBuffer>
    let mime = requestedMime(request)
    if (item.b64_json !== undefined) bytes = fromBase64(item.b64_json)
    else {
      const downloaded = await fetch(item.url!, { signal: request.signal })
      if (!downloaded.ok) throw new Error(`Generated image download failed: ${downloaded.status}`)
      bytes = new Uint8Array(await downloaded.arrayBuffer())
      mime = downloaded.headers.get('content-type')?.split(';', 1)[0] || mime
    }
    return { bytes, mime, ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}) }
  }))
}

export function createOpenAIImagesClient(baseURL: string, apiKey: string): ScopedImagesClient {
  const base = baseURL.replace(/\/+$/, '')
  return {
    async generate(request) {
      const editing = request.references.length > 0
      let body: BodyInit
      const headers = new Headers({ authorization: `Bearer ${apiKey}`, 'idempotency-key': request.idempotencyKey })
      if (editing) {
        const form = new FormData()
        form.set('model', request.modelId)
        form.set('prompt', request.prompt)
        appendOptions(form, request)
        for (const reference of request.references) {
          form.append('image', new File([reference.bytes], reference.filename, { type: reference.mime }))
        }
        body = form
      } else {
        headers.set('content-type', 'application/json')
        const { params } = request
        body = JSON.stringify({
          model: request.modelId,
          prompt: request.prompt,
          n: params.count,
          ...(params.size ? { size: `${params.size.width}x${params.size.height}` } : {}),
          ...(params.quality ? { quality: params.quality } : {}),
          ...(params.background ? { background: params.background } : {}),
          ...(params.output_format ? { output_format: params.output_format } : {}),
        })
      }
      const endpoint = `${base}/images/${editing ? 'edits' : 'generations'}`
      return readResponse(await fetch(endpoint, { method: 'POST', headers, body, signal: request.signal }), request)
    },
  }
}
