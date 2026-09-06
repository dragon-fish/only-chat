import { env } from 'cloudflare:workers'
import { createExecutionContext } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@/server/app'
import { createDb } from '@/server/db/client'
import { attachmentProviderFiles, attachments, providers, users } from '@/server/db/schema'
import worker from '@/server/index'
import { DEFAULT_USER_ID } from '@/shared/constants'

describe('createApp', () => {
  it('provides db and assets on the worker side and seeds user 1', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    const rows = await ctx.db.orm.select().from(users)
    expect(rows.map((u) => u.id)).toContain(1)

    await ctx.assets.put('1/ab/abc', new TextEncoder().encode('hello'), 'text/plain')
    expect(await ctx.assets.exists('1/ab/abc')).toBe(true)
    const got = await ctx.assets.getBytes('1/ab/abc')
    expect(got?.mime).toBe('text/plain')
    expect(new TextDecoder().decode(got!.bytes)).toBe('hello')
    expect(await ctx.assets.getBytes('missing')).toBeNull()
  })

  it('builds independent roots', async () => {
    const a = await createApp({ env, side: 'worker' })
    const b = await createApp({ env, side: 'worker' })
    expect(a.db).not.toBe(b.db)
  })

  it('rejects a missing or too-short KEY_ENCRYPTION_SECRET', async () => {
    await expect(createApp({ env: { ...env, KEY_ENCRYPTION_SECRET: '' } as Env, side: 'worker' }))
      .rejects.toThrow('KEY_ENCRYPTION_SECRET is missing or too short')
  })
})

describe('scheduled provider file cleanup', () => {
  it('deletes only expired pointers and issues no remote call', async () => {
    const db = createDb(env.DB)
    await createApp({ env, side: 'worker' }) // seeds user 1
    const [p] = await db.insert(providers).values({
      user_id: DEFAULT_USER_ID, name: 'cron', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1',
      api_key: null, extra: null, enabled: true, native_files: true, created_at: 0,
    }).returning()
    const [a] = await db.insert(attachments).values({
      user_id: DEFAULT_USER_ID, sha256: 'c'.repeat(64), mime: 'image/png', size: 4, width: null, height: null,
      r2_key: 'k/cron', origin: 'upload', created_at: 0,
    }).returning()
    const [q] = await db.insert(providers).values({
      user_id: DEFAULT_USER_ID, name: 'cron-2', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1',
      api_key: null, extra: null, enabled: true, native_files: true, created_at: 0,
    }).returning()
    const now = Date.now()
    await db.insert(attachmentProviderFiles).values([
      { attachment_id: a!.id, provider_id: p!.id, provider_reference: { openai: 'file-stale' }, expires_at: now - 1, created_at: 0 },
      { attachment_id: a!.id, provider_id: q!.id, provider_reference: { openai: 'file-live' }, expires_at: now + 60_000, created_at: 0 },
    ])

    // The remote copy is the provider's to expire; the job may only touch D1.
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await worker.scheduled!({ scheduledTime: now, cron: '0 3 * * *', noRetry: () => {} }, env, createExecutionContext())
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchSpy).not.toHaveBeenCalled()

    const rows = await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, a!.id))
    expect(rows.map((r) => r.provider_reference)).toEqual([{ openai: 'file-live' }])
  })
})
