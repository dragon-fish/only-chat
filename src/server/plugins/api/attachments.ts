import type { Context } from 'cordis'
import { Hono, type Context as HonoContext } from 'hono'
import { and, eq } from 'drizzle-orm'
import { authUserId, type ApiEnv } from './auth'
import { AttachmentCheckRequestSchema } from '@/shared/api'
import { attachments, type AttachmentRow } from '../../db/schema'
import { parseId } from './params'

import { uploadProblem } from '@/shared/upload-policy'
import { resolveUploadPolicy } from '../upload-policy'
import { MAX_ATTACHMENT_BYTES, matchesFileSignature } from '@/shared/file-media'

/** Bounds images a model generates; uploaded files are bounded by the site upload policy instead. */
export const MAX_GENERATED_IMAGE_BYTES = MAX_ATTACHMENT_BYTES

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function r2Key(userId: number, sha256: string): string {
  return `${userId}/${sha256.slice(0, 2)}/${sha256}`
}

export function attachmentRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  const db = ctx.db.orm

  r.post('/attachments/check', async (c) => {
    const userId = authUserId(c)
    const parsed = AttachmentCheckRequestSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input' }, 400)
    const row = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, userId), eq(attachments.sha256, parsed.data.sha256)) })
    if (row) {
      const problem = uploadProblem(await resolveUploadPolicy(db), row.mime, row.size)
      if (problem) return c.json({ error: problem.message }, problem.status)
    }
    return c.json(row ? { exists: true, attachment_id: row.id } : { exists: false })
  })

  r.put('/attachments/:sha256', async (c) => {
    const userId = authUserId(c)
    const claimed = c.req.param('sha256')
    const mime = c.req.header('content-type') ?? ''
    const policy = await resolveUploadPolicy(db)
    const declaredSize = Number(c.req.header('content-length'))
    const earlyProblem = uploadProblem(policy, mime, declaredSize > 0 ? declaredSize : 1)
    if (earlyProblem) return c.json({ error: earlyProblem.message }, earlyProblem.status)
    const bytes = await c.req.arrayBuffer()
    const problem = uploadProblem(policy, mime, bytes.byteLength)
    if (problem) return c.json({ error: problem.message }, problem.status)
    if (!matchesFileSignature(mime, new Uint8Array(bytes))) return c.json({ error: 'file content does not match mime' }, 415)
    const actual = hex(await crypto.subtle.digest('SHA-256', bytes))
    if (actual !== claimed) return c.json({ error: 'sha256 mismatch' }, 400)

    const existing = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, userId), eq(attachments.sha256, actual)) })
    if (existing) {
      const existingProblem = uploadProblem(policy, existing.mime, existing.size)
      if (existingProblem) return c.json({ error: existingProblem.message }, existingProblem.status)
      return c.json({ attachment_id: existing.id }, 201)
    }

    const key = r2Key(userId, actual)
    await ctx.assets.put(key, bytes, mime)
    const w = mime.startsWith('image/') ? Number(c.req.query('w')) || null : null
    const h = mime.startsWith('image/') ? Number(c.req.query('h')) || null : null
    const [row] = await db.insert(attachments).values({
      user_id: userId, sha256: actual, mime, size: bytes.byteLength, width: w, height: h,
      r2_key: key, origin: 'upload', created_at: Date.now(),
    }).returning()
    return c.json({ attachment_id: row!.id }, 201)
  })

  r.get('/attachments/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    const row = id === null ? undefined : await db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.user_id, authUserId(c))) })
    return serveAttachment(ctx, c, row)
  })

  return r
}

/** Answers with one attachment's bytes, or a 404 when `row` is absent. The caller decides whose rows it may look up. */
export async function serveAttachment(ctx: Context, c: HonoContext<ApiEnv>, row: AttachmentRow | undefined): Promise<Response> {
  // Successes below are cached for a year; a refusal is about who is asking and must not be.
  if (!row) return c.json({ error: 'not found' }, 404, { 'cache-control': 'no-store' })
  /**
   * Bytes are content-addressed and these rows are only ever inserted or deleted, so what an id
   * serves cannot change and revalidating settles nothing.
   *
   * `private` is the load-bearing word: the URL names no user, so a shared cache in front of this
   * Worker would answer one account's request with another account's picture. Never `public`
   * without moving an unguessable credential into the URL — and note that even then the URL
   * becomes a bearer token nobody can revoke, which is why the preview route uses short tickets.
   *
   * What remains is the browser's own store, which belongs to the browser and not to the cookie
   * currently in it. Sign-out sends `Clear-Site-Data: "cache"` for exactly that reason.
   */
  const headers = {
    'cache-control': 'private, max-age=31536000, immutable',
    etag: `"${row.sha256}"`,
    vary: 'Cookie',
    'x-content-type-options': 'nosniff',
  }
  // One row read and no object read, which is the whole point of answering it here.
  if (c.req.header('if-none-match') === headers.etag) return new Response(null, { status: 304, headers })

  // Media elements seek with `Range`, and Safari will not play audio or video without a 206.
  const range = parseByteRange(c.req.header('range'), row.size)
  if (range === null) {
    return new Response(null, { status: 416, headers: { 'cache-control': 'no-store', 'content-range': `bytes */${row.size}` } })
  }
  const stored = await ctx.assets.getStream(row.r2_key, range)
  if (!stored) return c.json({ error: 'object missing' }, 404, { 'cache-control': 'no-store' })
  if (range) {
    return new Response(stored.body, {
      status: 206,
      headers: {
        ...headers, 'accept-ranges': 'bytes', 'content-type': row.mime, 'content-length': String(range.length),
        'content-range': `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`,
      },
    })
  }
  return new Response(stored.body, {
    headers: { ...headers, 'accept-ranges': 'bytes', 'content-type': row.mime, 'content-length': String(stored.size) },
  })
}

/**
 * A single `bytes=` range resolved against `size`. `undefined` means serve the whole file — no
 * header, several ranges, or a malformed one, all of which RFC 9110 lets a server ignore; `null`
 * means unsatisfiable (416).
 */
export function parseByteRange(header: string | undefined, size: number): { offset: number; length: number } | null | undefined {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match || (!match[1] && !match[2])) return undefined
  if (!match[1]) {
    const suffix = Number(match[2])
    if (suffix === 0) return null
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }
  const start = Number(match[1])
  if (start >= size) return null
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (end < start) return undefined
  return { offset: start, length: end - start + 1 }
}
