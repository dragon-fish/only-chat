import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIFiles } from '@/server/plugins/llm/files/openai'
import { createAnthropicFiles } from '@/server/plugins/llm/files/anthropic'

const settings = { baseURL: 'https://gateway.example/api/v1///', apiKey: 'secret-files-key', credentialVersion: 7 }
const upload = { data: { type: 'text' as const, text: 'file bytes' }, mediaType: 'text/plain', filename: 'notes.txt' }
const openaiFile = { id: 'file-openai', object: 'file', bytes: 10, created_at: 1000, filename: 'notes.txt', purpose: 'user_data', expires_at: 5000 }
const anthropicFile = { id: 'file-anthropic', type: 'file', filename: 'notes.txt', mime_type: 'text/plain', size_bytes: 10, created_at: '2026-09-08T00:00:00Z', downloadable: false }

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI Files client', () => {
  it('uploads with a seven-day expiry and retains the provider expiration', async () => {
    let request: Request | undefined
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init)
      return Response.json(openaiFile)
    })
    const scoped = createOpenAIFiles(settings)
    const result = await scoped.files.uploadFile(upload)
    expect(scoped).toMatchObject({ family: 'openai', baseURL: 'https://gateway.example/api/v1', credentialVersion: 7 })
    expect(request!.url).toBe('https://gateway.example/api/v1/files')
    expect(request!.headers.get('authorization')).toBe('Bearer secret-files-key')
    const form = await request!.formData()
    expect(form.get('purpose')).toBe('user_data')
    expect(form.get('expires_after[anchor]')).toBe('created_at')
    expect(form.get('expires_after[seconds]')).toBe('604800')
    expect(await (form.get('file') as File).text()).toBe('file bytes')
    expect(result.providerReference).toEqual({ openai: 'file-openai' })
    expect(result.expiresAt).toEqual(new Date(5_000_000))
  })
})

describe('Anthropic Files client', () => {
  it('adds expiry to the SDK multipart upload without losing its file, auth, or abort signal', async () => {
    let request: Request | undefined
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init)
      return Response.json(anthropicFile)
    })
    const scoped = createAnthropicFiles(settings)
    const result = await scoped.files.uploadFile({ ...upload, abortSignal: controller.signal })
    expect(scoped).toMatchObject({ family: 'anthropic', baseURL: 'https://gateway.example/api/v1', credentialVersion: 7 })
    expect(request!.url).toBe('https://gateway.example/api/v1/files')
    expect(request!.method).toBe('POST')
    expect(request!.headers.get('x-api-key')).toBe('secret-files-key')
    expect(request!.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(request!.headers.get('anthropic-beta')).toBe('files-api-2025-04-14')
    const form = await request!.formData()
    expect(form.getAll('expires_in_seconds')).toEqual(['604800'])
    expect((form.get('file') as File).name).toBe('notes.txt')
    expect(await (form.get('file') as File).text()).toBe('file bytes')
    expect(result.providerReference).toEqual({ anthropic: 'file-anthropic' })
    controller.abort()
    expect(request!.signal.aborted).toBe(true)
  })

  it.each([
    ['file/a?#雪', 'file%2Fa%3F%23%E9%9B%AA'],
    ['..', '%252E%252E'],
  ])('deletes one encoded file path segment (%s)', async (id, encodedId) => {
    let request: Request | undefined
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init)
      return Response.json({ id, type: 'file_deleted' })
    })
    const scoped = createAnthropicFiles(settings)
    expect(scoped.files.deleteFile).toBeTypeOf('function')
    const result = await scoped.files.deleteFile!({ file: { anthropic: id }, abortSignal: controller.signal, headers: { 'x-request-id': 'cleanup' } })
    expect(request!.url).toBe(`https://gateway.example/api/v1/files/${encodedId}`)
    expect(request!.method).toBe('DELETE')
    expect(request!.headers.get('x-api-key')).toBe('secret-files-key')
    expect(request!.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(request!.headers.get('anthropic-beta')).toBe('files-api-2025-04-14')
    expect(request!.headers.get('x-request-id')).toBe('cleanup')
    expect(result).toMatchObject({ deleted: true, providerReference: { anthropic: id } })
    controller.abort()
    expect(request!.signal.aborted).toBe(true)
  })

  it('uses the same versioned official endpoint for upload, scope, and delete', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input))
      return Response.json(init?.method === 'DELETE' ? { id: 'file-anthropic', type: 'file_deleted' } : anthropicFile)
    })
    const scoped = createAnthropicFiles({ ...settings, baseURL: 'https://api.anthropic.com///' })
    const result = await scoped.files.uploadFile(upload)
    await scoped.files.deleteFile!({ file: result.providerReference })
    expect(scoped.baseURL).toBe('https://api.anthropic.com/v1')
    expect(urls).toEqual(['https://api.anthropic.com/v1/files', 'https://api.anthropic.com/v1/files/file-anthropic'])
  })

  it('rejects missing references and unconfirmed deletion without reporting success', async () => {
    const remote = vi.fn(async () => Response.json({ id: 'different-file', type: 'file_deleted' }))
    vi.stubGlobal('fetch', remote)
    const { files } = createAnthropicFiles(settings)
    await expect(files.deleteFile!({ file: { openai: 'wrong-family' } })).rejects.toThrow()
    expect(remote).not.toHaveBeenCalled()
    await expect(files.deleteFile!({ file: { anthropic: 'file-anthropic' } })).rejects.toThrow()
  })

  it('releases a failed DELETE response body while retaining its HTTP status', async () => {
    let cancelled = false
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 429 }))
    const { files } = createAnthropicFiles(settings)
    await expect(files.deleteFile!({ file: { anthropic: 'file-anthropic' } })).rejects.toMatchObject({ statusCode: 429 })
    expect(cancelled).toBe(true)
  })
})

describe.each([
  { family: 'openai', create: createOpenAIFiles },
  { family: 'anthropic', create: createAnthropicFiles },
])('$family Files error boundary', ({ family, create }) => {
  it.each(['upload', 'delete'] as const)('retains HTTP status while redacting %s response errors', async operation => {
    vi.stubGlobal('fetch', async () => Response.json({ type: 'error', error: { type: 'authentication_error', message: `Invalid authorization: Bearer ${settings.apiKey}` } }, { status: 401 }))
    const { files } = create(settings)
    const result = await (operation === 'upload' ? files.uploadFile(upload) : files.deleteFile!({ file: { [family]: 'file-test' } })).then(() => undefined, (error: unknown) => error)
    expect(result).toMatchObject({ statusCode: 401 })
    expect(String(result)).not.toContain(settings.apiKey)
    expect(JSON.stringify(result)).not.toContain(settings.apiKey)
  })

  it('does not expose credentials from thrown network errors or their causes', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError(`network: ${settings.apiKey}`, { cause: new Error(`x-api-key: ${settings.apiKey}`) }) })
    const result = await create(settings).files.uploadFile(upload).then(() => undefined, (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).not.toContain(settings.apiKey)
    expect(JSON.stringify(result)).not.toContain(settings.apiKey)
    expect((result as Error).cause).toBeUndefined()
  })

  it.each(['ftp://files.example/v1', 'https://user:secret-files-key@files.example/v1', 'https://files.example/v1?key=secret-files-key', 'https://files.example/v1#fragment', 'not-a-url'])('rejects an invalid Files base URL before making a request (%s)', baseURL => {
    const remote = vi.fn()
    vi.stubGlobal('fetch', remote)
    expect(() => create({ ...settings, baseURL })).toThrow()
    expect(remote).not.toHaveBeenCalled()
  })
})
