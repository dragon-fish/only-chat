import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIImagesClient } from '@/server/plugins/llm/images/openai'
import type { ImageGenerationRequest } from '@/server/plugins/llm/images/types'

const BASE = 'https://ark.example.com/api/v3'

function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    modelId: 'doubao-seedream-5-0-pro-260628',
    prompt: 'a cat',
    references: [],
    params: { count: 1, size: null },
    idempotencyKey: 'idem-1',
    ...overrides,
  }
}

function respondWith(status: number, body: string) {
  const fetchMock = vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { vi.unstubAllGlobals() })

describe('a rejected Images API request says enough to diagnose it', () => {
  it('names the endpoint, the upstream code and what the provider said', async () => {
    respondWith(400, JSON.stringify({ error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }))
    const client = createOpenAIImagesClient(BASE, 'key')

    const failure = await client.generate(request()).catch((error: Error) => error.message)

    expect(failure).toBe('Images API request failed: 400 at /images/generations (moderation_blocked): Your request was rejected by the safety system.')
  })

  it('redacts credentials a provider echoes back', async () => {
    const key = 'sk-live-0123456789abcdefghij'
    respondWith(401, JSON.stringify({ error: { message: `Incorrect API key ${key}; header was Bearer ${key}. Try ak_9f8e7d6c5b4a3210 or token abcdefghijklmnopqrstuvwxyz0123456789ABCD.` } }))
    const client = createOpenAIImagesClient(BASE, key)

    const failure = await client.generate(request()).catch((error: Error) => error.message)

    expect(failure).toContain('Incorrect API key')
    expect(failure).not.toContain(key)
    expect(failure).not.toContain('ak_9f8e7d6c5b4a3210')
    expect(failure).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
  })

  it('caps the provider text at 500 characters', async () => {
    respondWith(400, JSON.stringify({ error: { message: 'too long '.repeat(200) } }))
    const failure = await createOpenAIImagesClient(BASE, 'key').generate(request()).then(() => '', (error: Error) => error.message)
    expect(failure.length).toBeLessThanOrEqual('Images API request failed: 400 at /images/generations: '.length + 500)
  })

  it('reports the edits endpoint when the request carried a reference', async () => {
    respondWith(404, JSON.stringify({ error: { code: 'NotFound' } }))
    const client = createOpenAIImagesClient(BASE, 'key')
    const reference = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', filename: 'ref.png' }

    const failure = await client.generate(request({ references: [reference] })).catch((error: Error) => error.message)

    expect(failure).toContain('/images/edits')
  })

  it('still reports the endpoint when the body is not the shape we expect', async () => {
    respondWith(502, '<html>gateway</html>')
    const client = createOpenAIImagesClient(BASE, 'key')

    const failure = await client.generate(request()).catch((error: Error) => error.message)

    expect(failure).toContain('502')
    expect(failure).toContain('/images/generations')
    expect(failure).not.toContain('html')
  })

  it('drops a code that is not a short token, because that is free text', async () => {
    respondWith(400, JSON.stringify({ error: { code: 'your key sk-abc123 is invalid for this endpoint' } }))
    const client = createOpenAIImagesClient(BASE, 'key')

    const failure = await client.generate(request()).catch((error: Error) => error.message)

    expect(failure).toContain('400')
    expect(failure).not.toContain('sk-abc123')
  })
})
