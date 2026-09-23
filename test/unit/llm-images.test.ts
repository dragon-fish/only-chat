import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIImagesClient } from '@/server/plugins/llm/images/openai'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

describe('OpenAI-compatible Images client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('omits automatic options from generation JSON and decodes base64 output', async () => {
    let request: Request | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init)
      return Response.json({ data: [{ b64_json: btoa(String.fromCharCode(...png)), revised_prompt: 'Revised' }] })
    })
    const client = createOpenAIImagesClient('https://gateway.example/v1/', 'secret')
    const output = await client.generate({
      modelId: 'image-model', prompt: 'An otter', references: [], idempotencyKey: 'run-1',
      params: { count: 1, size: null },
    })

    expect(request?.url).toBe('https://gateway.example/v1/images/generations')
    expect(request?.headers.get('authorization')).toBe('Bearer secret')
    expect(request?.headers.get('idempotency-key')).toBe('run-1')
    expect(await request?.json()).toEqual({ model: 'image-model', prompt: 'An otter', n: 1 })
    expect(output).toEqual({ images: [{ bytes: png, mime: 'image/png', revisedPrompt: 'Revised' }], usage: null })
  })

  it('sends explicit generation options without inventing provider defaults', async () => {
    let body: unknown
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      body = await new Request(input, init).json()
      return Response.json({ data: [{ b64_json: btoa(String.fromCharCode(...png)) }] })
    })
    await createOpenAIImagesClient('https://gateway.example/v1', 'secret').generate({
      modelId: 'image-model', prompt: 'An otter', references: [], idempotencyKey: 'run-2',
      params: {
        count: 2, size: { width: 2048, height: 2048 }, quality: 'max',
        background: 'transparent', output_format: 'webp',
      },
    })
    expect(body).toEqual({
      model: 'image-model', prompt: 'An otter', n: 2, size: '2048x2048', quality: 'max',
      background: 'transparent', output_format: 'webp',
    })
  })

  it('uses multipart edits and downloads temporary URL outputs', async () => {
    let editRequest: Request | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url === 'https://cdn.example/output.webp') {
        return new Response(png, { headers: { 'content-type': 'image/webp' } })
      }
      editRequest = request
      return Response.json({ data: [{ url: 'https://cdn.example/output.webp' }] })
    })
    const output = await createOpenAIImagesClient('https://gateway.example/v1', 'secret').generate({
      modelId: 'image-model', prompt: 'Make it dusk', idempotencyKey: 'run-3',
      references: [{ bytes: png, mime: 'image/png', filename: 'reference.png' }],
      params: { count: 1, size: null },
    })

    expect(editRequest?.url).toBe('https://gateway.example/v1/images/edits')
    expect(editRequest?.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    const form = await editRequest?.formData()
    expect(form?.get('model')).toBe('image-model')
    expect(form?.get('prompt')).toBe('Make it dusk')
    expect(form?.get('n')).toBe('1')
    expect(form?.getAll('image')).toHaveLength(1)
    expect(output).toEqual({ images: [{ bytes: png, mime: 'image/webp' }], usage: null })
  })

  it('uses generations JSON for providers whose image input is a generation extension', async () => {
    let request: Request | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init)
      return Response.json({
        data: [{ b64_json: btoa(String.fromCharCode(...png)) }],
        usage: { generated_images: 1, output_tokens: 2048, total_tokens: 2048 },
      })
    })
    const output = await createOpenAIImagesClient('https://ark.example/v1', 'secret', { referenceMode: 'generation-json' }).generate({
      modelId: 'seedream', prompt: 'Full body', idempotencyKey: 'run-4',
      references: [{ bytes: png, mime: 'image/png', filename: 'reference.png' }],
      params: { count: 1, size: null },
    })

    expect(request?.url).toBe('https://ark.example/v1/images/generations')
    expect(request?.headers.get('content-type')).toBe('application/json')
    expect(await request?.json()).toEqual({
      model: 'seedream', prompt: 'Full body', n: 1,
      image: `data:image/png;base64,${btoa(String.fromCharCode(...png))}`,
    })
    expect(output.usage).toEqual({ generated_images: 1, output_tokens: 2048, total_tokens: 2048 })
  })

  it('merges extra body entries last, over the standard options, in both JSON and multipart bodies', async () => {
    const requests: Request[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return Response.json({ data: [{ b64_json: btoa(String.fromCharCode(...png)) }] })
    })
    const client = createOpenAIImagesClient('https://gateway.example/v1', 'secret')
    const extra = { watermark: false, size: '2K', options: { seed: 7 }, label: 'raw' }
    await client.generate({
      modelId: 'seedream', prompt: 'An otter', references: [], idempotencyKey: 'run-5',
      params: { count: 1, size: { width: 1024, height: 1024 }, extra },
    })
    await client.generate({
      modelId: 'seedream', prompt: 'An otter', idempotencyKey: 'run-6',
      references: [{ bytes: png, mime: 'image/png', filename: 'reference.png' }],
      params: { count: 1, size: null, extra },
    })

    expect(await requests[0]!.json()).toEqual({
      model: 'seedream', prompt: 'An otter', n: 1, size: '2K', watermark: false, options: { seed: 7 }, label: 'raw',
    })
    const form = await requests[1]!.formData()
    expect(form.get('watermark')).toBe('false')
    expect(form.get('size')).toBe('2K')
    expect(form.get('options')).toBe('{"seed":7}')
    expect(form.get('label')).toBe('raw')
  })
})
