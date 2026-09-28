import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadFile, uploadMime } from '@/client/lib/file-upload'
import { api } from '@/client/lib/api'
import { UploadPolicySchema } from '@/shared/upload-policy'

afterEach(() => vi.restoreAllMocks())

it('rejects disabled and oversized uploads before contacting storage', async () => {
  const put = vi.spyOn(api, 'uploadAttachment')
  const check = vi.spyOn(api, 'checkAttachment')
  await expect(uploadFile(new File(['ID3audio'], 'clip.mp3', { type: 'audio/mpeg' }), { maxBytes: 1000, allowedMimeTypes: ['application/pdf'] })).rejects.toThrow('不允许')
  await expect(uploadFile(new File(['%PDF-1.7'], 'doc.pdf', { type: 'application/pdf' }), { maxBytes: 4, allowedMimeTypes: ['application/pdf'] })).rejects.toThrow('不能超过')
  expect(check).not.toHaveBeenCalled()
  expect(put).not.toHaveBeenCalled()
})

it('allows a configured non-image upload and preserves its MIME', async () => {
  vi.spyOn(api, 'checkAttachment').mockResolvedValue({ exists: false })
  const put = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({ attachment_id: 22 })
  const result = await uploadFile(new File(['%PDF-1.7'], 'doc.pdf', { type: 'application/pdf' }), { maxBytes: 1024, allowedMimeTypes: ['application/pdf'] })
  expect(result).toMatchObject({ attachment_id: 22, mime: 'application/pdf', filename: 'doc.pdf' })
  expect(put.mock.calls[0]![1].type).toBe('application/pdf')
  URL.revokeObjectURL(result.preview)
})

it('permits closing uploads entirely but refuses unsupported formats', () => {
  expect(UploadPolicySchema.safeParse({ maxBytes: 1024, allowedMimeTypes: [] }).success).toBe(true)
  expect(UploadPolicySchema.safeParse({ maxBytes: 1024, allowedMimeTypes: ['application/zip'] }).success).toBe(false)
})

describe('chat image uploads', () => {
  function stubCanvas(encoded: number) {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4096, height: 4096, close() {} }))
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (callback: (blob: Blob) => void, type: string) => callback(new Blob([new Uint8Array(encoded)], { type })) }) })
  }
  afterEach(() => vi.unstubAllGlobals())

  it('checks the size limit after downscaling, not on the original photo', async () => {
    stubCanvas(100)
    vi.spyOn(api, 'checkAttachment').mockResolvedValue({ exists: false })
    const put = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({ attachment_id: 5 })
    const result = await uploadFile(new File([new Uint8Array(5000)], 'photo.jpg', { type: 'image/jpeg' }), { maxBytes: 1000, allowedMimeTypes: ['image/webp'] })
    expect(result).toMatchObject({ attachment_id: 5, mime: 'image/webp' })
    expect(put.mock.calls[0]![1].size).toBe(100)
    URL.revokeObjectURL(result.preview)
  })

  it('re-encodes a decodable image that is not a stored format', async () => {
    stubCanvas(10)
    vi.spyOn(api, 'checkAttachment').mockResolvedValue({ exists: false })
    const put = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({ attachment_id: 6 })
    const result = await uploadFile(new File(['BM'], 'scan.bmp', { type: 'image/bmp' }), { maxBytes: 1000, allowedMimeTypes: ['image/png', 'image/webp'] })
    expect(put.mock.calls[0]![1].type).toBe('image/webp')
    URL.revokeObjectURL(result.preview)
  })
})

it('resolves an untyped .webm by extension to video', () => {
  expect(uploadMime(new File(['x'], 'clip.webm'))).toBe('video/webm')
  expect(uploadMime(new File(['x'], 'voice.webm', { type: 'audio/webm' }))).toBe('audio/webm')
})

describe('stored upload policy', () => {
  it('drops unknown formats and clamps or replaces invalid limits instead of throwing', async () => {
    const { parseStoredUploadPolicy } = await import('@/server/plugins/upload-policy')
    const { DEFAULT_UPLOAD_POLICY, MAX_UPLOAD_POLICY_BYTES } = await import('@/shared/upload-policy')
    expect(parseStoredUploadPolicy(JSON.stringify({ maxBytes: 1024, allowedMimeTypes: ['application/pdf', 'application/x-retired', 'application/pdf'] })))
      .toEqual({ maxBytes: 1024, allowedMimeTypes: ['application/pdf'] })
    expect(parseStoredUploadPolicy(JSON.stringify({ maxBytes: 10 ** 12, allowedMimeTypes: [] }))).toEqual({ maxBytes: MAX_UPLOAD_POLICY_BYTES, allowedMimeTypes: [] })
    expect(parseStoredUploadPolicy(JSON.stringify({ maxBytes: -1 })).maxBytes).toBe(DEFAULT_UPLOAD_POLICY.maxBytes)
    expect(parseStoredUploadPolicy('{not json')).toEqual(DEFAULT_UPLOAD_POLICY)
  })
})
