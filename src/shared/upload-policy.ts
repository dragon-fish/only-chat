import { z } from 'zod'
import { FILE_EXTENSIONS, MAX_ATTACHMENT_BYTES } from './file-media'

export const UploadPolicySchema = z.strictObject({
  maxBytes: z.number().int().positive(),
  allowedMimeTypes: z.array(z.string().refine(mime => Object.hasOwn(FILE_EXTENSIONS, mime), 'Unsupported upload format'))
    .max(Object.keys(FILE_EXTENSIONS).length)
    .refine(types => new Set(types).size === types.length, 'Duplicate upload format'),
})
export type UploadPolicy = z.infer<typeof UploadPolicySchema>
export const DEFAULT_UPLOAD_POLICY: UploadPolicy = { maxBytes: MAX_ATTACHMENT_BYTES, allowedMimeTypes: Object.keys(FILE_EXTENSIONS) }
export function uploadLimitLabel(bytes: number): string {
  return `${Number((bytes / 1024 / 1024).toFixed(2))} MiB`
}
export function uploadProblem(policy: UploadPolicy, mime: string, size: number) {
  if (!policy.allowedMimeTypes.includes(mime)) return { status: 415 as const, message: `本站不允许上传此文件类型（${mime}）` }
  if (size <= 0) return { status: 400 as const, message: '文件不能为空' }
  if (size > policy.maxBytes) return { status: 413 as const, message: `文件不能超过 ${uploadLimitLabel(policy.maxBytes)}` }
  return null
}
