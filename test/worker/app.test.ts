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
  it('refreshes the catalog even when local pointer cleanup fails', async () => {
    const db = createDb(env.DB)
    await createApp({ env, side: 'worker' })
    const [provider] = await db.insert(providers).values({ user_id: 1, name: 'cleanup-failure', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1', created_at: 0 }).returning()
    const [attachment] = await db.insert(attachments).values({ user_id: 1, sha256: 'failure-cleanup', mime: 'text/plain', size: 1, r2_key: 'cleanup-failure', origin: 'upload', created_at: 0 }).returning()
    await db.insert(attachmentProviderFiles).values({ attachment_id: attachment!.id, provider_id: provider!.id, provider_reference: { openai: 'file-failure' }, expires_at: 0, created_at: 0 })
    await env.DB.exec("CREATE TRIGGER fail_file_cleanup BEFORE DELETE ON attachment_provider_files BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END")
    vi.stubGlobal('fetch', async () => Response.json({ providers: {}, models: {} }))
    try {
      await worker.scheduled!({ scheduledTime: Date.now(), cron: '0 3 * * *', noRetry: () => {} }, env, createExecutionContext())
      expect(await env.DB.prepare('SELECT current_version FROM model_catalog_refresh WHERE id = 1').first()).toMatchObject({ current_version: expect.any(String) })
    } finally {
      await env.DB.exec('DROP TRIGGER fail_file_cleanup')
      vi.unstubAllGlobals()
    }
    expect((await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, attachment!.id)))).toHaveLength(1)
  })

  it('deletes only expired pointers when catalog download fails', async () => {
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

    const fetchSpy = vi.fn(async () => { throw new Error('catalog unavailable') })
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await worker.scheduled!({ scheduledTime: now, cron: '0 3 * * *', noRetry: () => {} }, env, createExecutionContext())
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchSpy).toHaveBeenCalledWith('https://models.dev/catalog.json')

    const rows = await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, a!.id))
    expect(rows.map((r) => r.provider_reference)).toEqual([{ openai: 'file-live' }])
  })
})
