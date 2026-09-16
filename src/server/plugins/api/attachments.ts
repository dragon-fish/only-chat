import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { authUserId, type ApiEnv } from './auth'
import { AttachmentCheckRequestSchema } from '@/shared/api'
import { attachments } from '../../db/schema'
import { parseId } from './params'

/** One limit for everything that becomes an attachment, uploaded or generated (spec §4.7). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

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
    return c.json(row ? { exists: true, attachment_id: row.id } : { exists: false })
  })

  r.put('/attachments/:sha256', async (c) => {
    const userId = authUserId(c)
    const claimed = c.req.param('sha256')
    const mime = c.req.header('content-type') ?? ''
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return c.json({ error: 'unsupported mime' }, 415)
    const bytes = await c.req.arrayBuffer()
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: 'bad size' }, 400)
    const actual = hex(await crypto.subtle.digest('SHA-256', bytes))
    if (actual !== claimed) return c.json({ error: 'sha256 mismatch' }, 400)

    const existing = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, userId), eq(attachments.sha256, actual)) })
    if (existing) return c.json({ attachment_id: existing.id }, 201)

    const key = r2Key(userId, actual)
    await ctx.assets.put(key, bytes, mime)
    const w = Number(c.req.query('w')) || null
    const h = Number(c.req.query('h')) || null
    const [row] = await db.insert(attachments).values({
      user_id: userId, sha256: actual, mime, size: bytes.byteLength, width: w, height: h,
      r2_key: key, origin: 'upload', created_at: Date.now(),
    }).returning()
    return c.json({ attachment_id: row!.id }, 201)
  })

  r.get('/attachments/:id', async (c) => {
    const userId = authUserId(c)
    // Successes below are cached for a year; a refusal is about who is asking and must not be.
    const denied = () => c.json({ error: 'not found' }, 404, { 'cache-control': 'no-store' })
    const id = parseId(c.req.param('id'))
    if (id === null) return denied()
    const row = await db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.user_id, userId)) })
    if (!row) return denied()
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

    const stored = await ctx.assets.getStream(row.r2_key)
    if (!stored) return c.json({ error: 'object missing' }, 404, { 'cache-control': 'no-store' })
    return new Response(stored.body, {
      headers: { ...headers, 'content-type': row.mime, 'content-length': String(stored.size) },
    })
  })

  return r
}
