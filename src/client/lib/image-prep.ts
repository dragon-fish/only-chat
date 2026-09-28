import type { UploadPolicy } from '@/shared/upload-policy'
import { currentUploadPolicy, validateUpload } from './upload-policy'
import { api } from '@/client/lib/api'
import { MAX_IMAGE_EDGE } from '@/shared/constants'

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface PreparedImage {
  blob: Blob
  width: number
  height: number
  sha256: string
}

const ENCODABLE = ['image/png', 'image/jpeg', 'image/webp']

/**
 * Downscales to MAX_IMAGE_EDGE on the longest side, re-encodes, and hashes. Browser only.
 *
 * Anything the browser can decode is accepted as input (BMP, AVIF, HEIC where supported): it is
 * re-encoded, so only the resulting type has to be in `allowedTypes`. A PNG, JPEG or WebP that
 * needs no downscaling and is itself allowed is stored as-is.
 */
export async function prepareImage(file: Blob, allowedTypes?: readonly string[]): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const allowed = (mime: string) => !allowedTypes || allowedTypes.includes(mime)
  let blob: Blob = file
  const preferred = file.type === 'image/png' ? 'image/png' : 'image/webp'
  const type = [preferred, file.type, ...ENCODABLE].find(mime => ENCODABLE.includes(mime) && allowed(mime))
  const keep = scale === 1 && ENCODABLE.includes(file.type) && allowed(file.type)
  // No allowed encodable target leaves the original in place; the caller's policy check refuses it.
  if (type && !keep) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, 0.9))
  }
  const result = { blob, width: blob === file ? bitmap.width : width, height: blob === file ? bitmap.height : height, sha256: await sha256Hex(await blob.arrayBuffer()) }
  bitmap.close()
  return result
}

/**
 * The size limit is checked on the prepared blob, never on the original: a large photo that
 * downscales under the limit must go through.
 */
export async function uploadImage(file: Blob, suppliedPolicy?: UploadPolicy): Promise<{ attachment_id: number; preview: string; mime: string }> {
  const policy = suppliedPolicy ?? await currentUploadPolicy()
  let prepared: PreparedImage
  try { prepared = await prepareImage(file, policy.allowedMimeTypes) }
  catch { throw new Error('浏览器无法读取此图片') }
  validateUpload(policy, prepared.blob.type, prepared.blob.size)
  const check = await api.checkAttachment(prepared.sha256)
  const attachment_id = check.exists && check.attachment_id !== undefined
    ? check.attachment_id
    : (await api.uploadAttachment(prepared.sha256, prepared.blob, prepared.width, prepared.height)).attachment_id
  return { attachment_id, preview: URL.createObjectURL(prepared.blob), mime: prepared.blob.type }
}
