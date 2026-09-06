import type { GeneratedFile } from 'ai'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import type { ImagePart } from '@/shared/parts'
import type { DB } from '../../db/client'
import { attachments } from '../../db/schema'
import { MAX_UPLOAD_BYTES, r2Key } from '../api/attachments'
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

/**
 * The bytes a `file` stream part actually stands for. A provider that answers with a link puts the
 * URL verbatim into `base64` (ai@7 `DefaultGeneratedFile` stores `data.url.toString()` there), so
 * the string has to be inspected before `uint8Array` decodes it as if it were base64.
 */
async function readOutput(file: GeneratedFile): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  if (!file.base64.startsWith('https://')) {
    // Copied out of the SDK's buffer: `crypto.subtle` needs bytes backed by a plain ArrayBuffer.
    return { bytes: new Uint8Array(file.uint8Array), mime: baseMime(file.mediaType) }
  }
  const response = await fetch(file.base64)
  if (!response.ok) throw new Error(`generated image download failed: ${response.status}`)
  // What the download served decides the type: the URL itself is never persisted or trusted.
  const mime = response.headers.get('content-type') ?? file.mediaType
  return { bytes: new Uint8Array(await response.arrayBuffer()), mime: baseMime(mime) }
}

/** Type and size are settled before the digest is taken, so rejected output is never hashed. */
async function validate(file: GeneratedFile): Promise<ValidatedImage> {
  const { bytes, mime } = await readOutput(file)
  if (!ACCEPTED_MIME.has(mime)) throw new Error(`unsupported generated image type: ${mime || 'unknown'}`)
  if (bytes.byteLength === 0) throw new Error('generated image is empty')
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`generated image too large: ${bytes.byteLength} bytes`)
  return { bytes, mime, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) }
}

function findBySha(db: DB, sha256: string) {
  return db.query.attachments.findFirst({ where: and(eq(attachments.user_id, DEFAULT_USER_ID), eq(attachments.sha256, sha256)) })
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
  const existing = await findBySha(hub.db, sha256)
  if (existing) return { type: 'image', attachment_id: existing.id }

  const key = r2Key(DEFAULT_USER_ID, sha256)
  await hub.app.assets.put(key, bytes, mime)
  try {
    const [row] = await hub.db.insert(attachments).values({
      user_id: DEFAULT_USER_ID, sha256, mime, size: bytes.byteLength, width: null, height: null,
      r2_key: key, origin: 'generated', created_at: Date.now(),
    }).returning()
    if (!row) throw new Error('attachment insert returned no row')
    return { type: 'image', attachment_id: row.id }
  } catch (err) {
    // A concurrent generation of the same bytes may have taken the unique index in the meantime.
    // That row owns this key — identical digest, identical object — so the object stays.
    const owner = await findBySha(hub.db, sha256).catch(() => undefined)
    if (owner) return { type: 'image', attachment_id: owner.id }
    // Nothing owns what this call wrote; leaving it would be a half-written R2 pointer. Cleanup is
    // best effort because the insert failure is the one the caller needs to see.
    await hub.app.assets.delete(key).catch((cleanupErr) => console.error('r2 cleanup failed for', key, cleanupErr))
    throw err
  }
}
