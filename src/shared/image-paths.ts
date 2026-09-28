/**
 * How the images of a conversation are named to the model. One namespace for every consumer: the
 * labels in the prompt, task notifications, `generate_image` references, and — when workspace
 * files are on — the read-only `/artifacts` and `/uploads` mounts that `read_file` can open.
 */
import { FILE_EXTENSIONS } from './file-media'

export function imageExtension(mime: string): string {
  return FILE_EXTENSIONS[mime] ?? 'bin'
}

/** An image a run produced. Named by artifact id: task notifications already hand the model these paths. */
export function artifactPath(artifactId: number, mime: string): string {
  return `/artifacts/${artifactId}.${imageExtension(mime)}`
}

/** An image the chat model produced inline, which has no artifact row, only an attachment. */
export function generatedPath(attachmentId: number, mime: string): string {
  return `/artifacts/msg-${attachmentId}.${imageExtension(mime)}`
}

export function uploadPath(attachmentId: number, mime: string): string {
  return `/uploads/${attachmentId}.${imageExtension(mime)}`
}
