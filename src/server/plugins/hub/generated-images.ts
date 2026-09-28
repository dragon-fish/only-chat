import type { GeneratedFile } from 'ai'
import { and, eq } from 'drizzle-orm'
import type { ImagePart } from '@/shared/parts'
import type { DB } from '../../db/client'
import { attachments } from '../../db/schema'
import { MAX_GENERATED_IMAGE_BYTES, r2Key } from '../api/attachments'
import type { Hub } from './index'

/** The same set the upload route accepts; a generated file gets no wider licence than a user one. */
const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

interface ValidatedImage {
  bytes: Uint8Array<ArrayBuffer>
  mime: string
  sha256: string
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `image/png; charset=binary` and `IMAGE/PNG` both name the same type. */
function baseMime(value: string): string {
  return value.split(';')[0]!.trim().toLowerCase()
}

/** One wording for the limit, wherever it is reached: a declared length or the bytes themselves. */
function tooLarge(bytes: number): Error {
  return new Error(`generated image too large: ${bytes} bytes`)
}

/**
 * The bytes a `file` stream part actually stands for. A provider that answers with a link puts the
 * URL verbatim into `base64` (ai@7 `DefaultGeneratedFile` stores `data.url.toString()` there), so
 * the string has to be inspected before `uint8Array` decodes it as if it were base64.
 *
 * Both branches refuse an oversized output before they materialise it.
 */
async function readOutput(file: GeneratedFile): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  if (!file.base64.startsWith('https://')) {
    const inline = file.uint8Array
    // Decided from the length alone, before anything is duplicated: this runs inside the `UserHub`
    // DO, where a needless second copy of an oversized buffer costs every socket on the isolate.
    if (inline.byteLength > MAX_GENERATED_IMAGE_BYTES) throw tooLarge(inline.byteLength)
    // Copied out of the SDK's buffer: `crypto.subtle` needs bytes backed by a plain ArrayBuffer.
    return { bytes: new Uint8Array(inline), mime: baseMime(file.mediaType) }
  }
  const response = await fetch(file.base64)
  if (!response.ok) throw new Error(`generated image download failed: ${response.status}`)
  // An oversized body is refused before it is buffered at all. Buffering it first would not fail
  // one generation, it would OOM the DO and drop every socket this user has. A missing or
  // non-numeric header is not an error, it only means there is nothing to reject early on.
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_GENERATED_IMAGE_BYTES) throw tooLarge(declared)
  // What the download served decides the type: the URL itself is never persisted or trusted.
  const mime = response.headers.get('content-type') ?? file.mediaType
  return { bytes: new Uint8Array(await response.arrayBuffer()), mime: baseMime(mime) }
}

/**
 * Type and size are settled before the digest is taken, so rejected output is never hashed. The
 * size limit is checked here against the bytes that actually arrived; `readOutput`'s own checks are
 * early rejections on a declared length, and a body that under-declared itself still lands here.
 */
async function validate(file: GeneratedFile): Promise<ValidatedImage> {
  const { bytes, mime } = await readOutput(file)
  if (!ACCEPTED_MIME.has(mime)) throw new Error(`unsupported generated image type: ${mime || 'unknown'}`)
  if (bytes.byteLength === 0) throw new Error('generated image is empty')
  if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) throw tooLarge(bytes.byteLength)
  return { bytes, mime, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) }
}

function findBySha(db: DB, userId: number, sha256: string) {
  return db.query.attachments.findFirst({ where: and(eq(attachments.user_id, userId), eq(attachments.sha256, sha256)) })
}

/**
 * Turns one generated file into the only thing the rest of the system is allowed to see: an
 * `attachment_id` (spec §4.7). By the time this resolves the bytes are validated, hashed and in R2,
 * and a row owns the object; the base64 or temporary URL they came from never leaves this function.
 *
 * Failures propagate. The caller ends the reply as an error with its text intact rather than
 * writing file content anywhere (spec §9).
 */
export async function persistGeneratedImage(hub: Hub, file: GeneratedFile): Promise<ImagePart> {
  const { bytes, mime, sha256 } = await validate(file)
  const existing = await findBySha(hub.db, hub.userId, sha256)
  if (existing) return { type: 'image', attachment_id: existing.id }

  const key = r2Key(hub.userId, sha256)
  await hub.app.assets.put(key, bytes, mime)
  try {
    const [row] = await hub.db.insert(attachments).values({
      user_id: hub.userId, sha256, mime, size: bytes.byteLength, width: null, height: null,
      r2_key: key, origin: 'generated', created_at: Date.now(),
    }).returning()
    if (!row) throw new Error('attachment insert returned no row')
    return { type: 'image', attachment_id: row.id }
  } catch (err) {
    // A concurrent generation of the same bytes may have taken the unique index in the meantime.
    // That row owns this key — identical digest, identical object — so the object stays.
    const owner = await findBySha(hub.db, hub.userId, sha256).catch(() => undefined)
    if (owner) return { type: 'image', attachment_id: owner.id }
    // Nothing owns what this call wrote; leaving it would be a half-written R2 pointer. Cleanup is
    // best effort because the insert failure is the one the caller needs to see.
    await hub.app.assets.delete(key).catch((cleanupErr) => console.error('r2 cleanup failed for', key, cleanupErr))
    throw err
  }
}
