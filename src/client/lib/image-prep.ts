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

/** Downscales to MAX_IMAGE_EDGE on the longest side, re-encodes, and hashes. Browser only. */
export async function prepareImage(file: Blob, allowedTypes?: readonly string[]): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  let blob: Blob = file
  const encodable = ['image/png', 'image/jpeg', 'image/webp']
  const preferred = file.type === 'image/png' ? 'image/png' : 'image/webp'
  const type = allowedTypes
    ? [preferred, file.type, ...encodable].find(mime => encodable.includes(mime) && allowedTypes.includes(mime))
    : preferred
  if (type && (scale < 1 || !/^image\/(png|jpeg|webp)$/.test(file.type))) {
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

export async function uploadImage(file: Blob, suppliedPolicy?: UploadPolicy): Promise<{ attachment_id: number; preview: string }> {
  const policy = suppliedPolicy ?? await currentUploadPolicy()
  validateUpload(policy, file.type, file.size)
  const prepared = await prepareImage(file, policy.allowedMimeTypes)
  validateUpload(policy, prepared.blob.type, prepared.blob.size)
  const check = await api.checkAttachment(prepared.sha256)
  const attachment_id = check.exists && check.attachment_id !== undefined
    ? check.attachment_id
    : (await api.uploadAttachment(prepared.sha256, prepared.blob, prepared.width, prepared.height)).attachment_id
  return { attachment_id, preview: URL.createObjectURL(prepared.blob) }
}
