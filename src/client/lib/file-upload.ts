import type { UploadPolicy } from '@/shared/upload-policy'
import { currentUploadPolicy, validateUpload } from './upload-policy'
import { api } from './api'
import { sha256Hex, uploadImage } from './image-prep'
import { FILE_EXTENSIONS } from '@/shared/file-media'

export function uploadMime(file: File): string {
  const aliases: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/x-flac': 'audio/flac' }
  const declared = aliases[file.type] ?? file.type
  if (FILE_EXTENSIONS[declared]) return declared
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  return Object.entries(FILE_EXTENSIONS).find(([, ext]) => ext === extension)?.[0] ?? ''
}

export async function uploadFile(file: File, suppliedPolicy?: UploadPolicy) {
  const policy = suppliedPolicy ?? await currentUploadPolicy()
  const mime = uploadMime(file)
  if (!mime) throw new Error('支持图片、PDF、音频和视频文件')
  validateUpload(policy, mime, file.size)
  if (mime.startsWith('image/')) return { ...await uploadImage(file.slice(0, file.size, mime), policy), mime, filename: file.name }
  const blob = file.slice(0, file.size, mime)
  const sha256 = await sha256Hex(await blob.arrayBuffer())
  const check = await api.checkAttachment(sha256)
  const attachment_id = check.exists && check.attachment_id !== undefined ? check.attachment_id : (await api.uploadAttachment(sha256, blob)).attachment_id
  return { attachment_id, preview: URL.createObjectURL(blob), mime, filename: file.name }
}
