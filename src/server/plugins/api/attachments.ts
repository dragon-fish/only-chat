import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { AttachmentCheckRequestSchema } from '@/shared/api'
import { attachments } from '../../db/schema'
import { parseId } from './params'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function r2Key(userId: number, sha256: string): string {
  return `${userId}/${sha256.slice(0, 2)}/${sha256}`
}

export function attachmentRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm

  r.post('/attachments/check', async (c) => {
    const parsed = AttachmentCheckRequestSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input' }, 400)
    const row = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, DEFAULT_USER_ID), eq(attachments.sha256, parsed.data.sha256)) })
    return c.json(row ? { exists: true, attachment_id: row.id } : { exists: false })
  })

  r.put('/attachments/:sha256', async (c) => {
    const claimed = c.req.param('sha256')
    const mime = c.req.header('content-type') ?? ''
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return c.json({ error: 'unsupported mime' }, 415)
    const bytes = await c.req.arrayBuffer()
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: 'bad size' }, 400)
    const actual = hex(await crypto.subtle.digest('SHA-256', bytes))
    if (actual !== claimed) return c.json({ error: 'sha256 mismatch' }, 400)

    const existing = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, DEFAULT_USER_ID), eq(attachments.sha256, actual)) })
    if (existing) return c.json({ attachment_id: existing.id }, 201)

    const key = r2Key(DEFAULT_USER_ID, actual)
    await ctx.assets.put(key, bytes, mime)
    const w = Number(c.req.query('w')) || null
    const h = Number(c.req.query('h')) || null
    const [row] = await db.insert(attachments).values({
      user_id: DEFAULT_USER_ID, sha256: actual, mime, size: bytes.byteLength, width: w, height: h,
      r2_key: key, origin: 'upload', created_at: Date.now(),
    }).returning()
    return c.json({ attachment_id: row!.id }, 201)
  })

  r.get('/attachments/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const row = await db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.user_id, DEFAULT_USER_ID)) })
    if (!row) return c.json({ error: 'not found' }, 404)
    const stored = await ctx.assets.getStream(row.r2_key)
    if (!stored) return c.json({ error: 'object missing' }, 404)
    return new Response(stored.body, {
      headers: {
        'content-type': row.mime,
        'content-length': String(stored.size),
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    })
  })

  return r
}
