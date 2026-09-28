import { afterEach, expect, it, vi } from 'vitest'
import { uploadFile } from '@/client/lib/file-upload'
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
