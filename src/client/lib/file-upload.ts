import type { UploadPolicy } from '@/shared/upload-policy'
import { currentUploadPolicy, validateUpload } from './upload-policy'
import { api } from './api'
import { sha256Hex, uploadImage } from './image-prep'
import { FILE_EXTENSIONS, mimeFromExtension } from '@/shared/file-media'

const MIME_ALIASES: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/x-flac': 'audio/flac' }

/**
 * The MIME a picked file is uploaded under, or '' when it cannot be sent at all. The declared type
 * wins over the extension. Any declared `image/*` is returned as-is even when it is not a stored
 * format: `prepareImage` re-encodes it, and only the re-encoded type is checked against the policy.
 */
export function uploadMime(file: File): string {
  const declared = MIME_ALIASES[file.type] ?? file.type
  if (FILE_EXTENSIONS[declared] || declared.startsWith('image/')) return declared
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
  return mimeFromExtension(extension) ?? ''
}

/** A chat message attachment: the site upload policy applies. */
export async function uploadFile(file: File, suppliedPolicy?: UploadPolicy) {
  const policy = suppliedPolicy ?? await currentUploadPolicy()
  const mime = uploadMime(file)
  if (!mime) throw new Error('支持图片、PDF、音频和视频文件')
  if (mime.startsWith('image/')) return { ...await uploadImage(file.slice(0, file.size, mime), policy), filename: file.name }
  validateUpload(policy, mime, file.size)
  const blob = file.slice(0, file.size, mime)
  const sha256 = await sha256Hex(await blob.arrayBuffer())
  const check = await api.checkAttachment(sha256, 'chat')
  const attachment_id = check.exists && check.attachment_id !== undefined ? check.attachment_id : (await api.uploadAttachment(sha256, blob, { purpose: 'chat' })).attachment_id
  return { attachment_id, preview: URL.createObjectURL(blob), mime, filename: file.name }
}
