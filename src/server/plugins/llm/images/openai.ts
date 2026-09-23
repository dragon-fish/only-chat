import { z } from 'zod'
import type { ImageGenerationRequest, ImageGenerationResult, ScopedImagesClient } from './types'

const ResponseSchema = z.object({
  data: z.array(z.object({
    b64_json: z.string().optional(),
    url: z.string().url().optional(),
    revised_prompt: z.string().optional(),
  }).refine(value => value.b64_json !== undefined || value.url !== undefined, 'image data missing')).min(1),
  usage: z.object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    total_tokens: z.number().nonnegative().optional(),
    generated_images: z.number().nonnegative().optional(),
  }).passthrough().optional(),
})

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index)
  return bytes
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary)
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
  // Multipart fields are text: a string travels as-is, anything else as its JSON.
  for (const [key, value] of Object.entries(params.extra ?? {})) body.set(key, typeof value === 'string' ? value : JSON.stringify(value))
}

/**
 * A provider's error `code` is a classification token; its `message` is free text that routinely
 * quotes the request back, which is how a credential ends up in one. Only the token may travel into
 * `artifact_runs.error`, where a user reads it — the same rule `fileCleanupError` follows.
 */
const UPSTREAM_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

async function upstreamCode(response: Response): Promise<string | null> {
  const body = await response.text().catch(() => '')
  let parsed: unknown
  try { parsed = JSON.parse(body) }
  catch { return null }
  const error = (parsed as { error?: unknown })?.error
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : (parsed as { code?: unknown })?.code
  return typeof code === 'string' && UPSTREAM_CODE.test(code) ? code : null
}

async function readResponse(response: Response, request: ImageGenerationRequest, path: string): Promise<ImageGenerationResult> {
  if (!response.ok) {
    // The path matters as much as the status: which of the two endpoints was called depends on
    // whether the request carried a reference, and a 404 means different things for each.
    const code = await upstreamCode(response)
    throw new Error(`Images API request failed: ${response.status} at ${path}${code === null ? '' : ` (${code})`}`)
  }
  const parsed = ResponseSchema.parse(await response.json())
  const images = await Promise.all(parsed.data.map(async (item) => {
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
  return { images, usage: parsed.usage ?? null }
}

export function createOpenAIImagesClient(
  baseURL: string,
  apiKey: string,
  options: { referenceMode?: 'multipart-edits' | 'generation-json' } = {},
): ScopedImagesClient {
  const base = baseURL.replace(/\/+$/, '')
  return {
    async generate(request) {
      const editing = request.references.length > 0
      let body: BodyInit
      const headers = new Headers({ authorization: `Bearer ${apiKey}`, 'idempotency-key': request.idempotencyKey })
      if (editing && options.referenceMode !== 'generation-json') {
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
          ...(editing ? {
            image: request.references.length === 1
              ? `data:${request.references[0]!.mime};base64,${toBase64(request.references[0]!.bytes)}`
              : request.references.map(reference => `data:${reference.mime};base64,${toBase64(reference.bytes)}`),
          } : {}),
          ...params.extra,
        })
      }
      // Only the path we built travels into the error: a base URL can carry a key in its query.
      const path = `/images/${editing && options.referenceMode !== 'generation-json' ? 'edits' : 'generations'}`
      const response = await fetch(`${base}${path}`, { method: 'POST', headers, body, signal: request.signal })
      return readResponse(response, request, path)
    },
  }
}
