import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/server/app'
import { users } from '@/server/db/schema'

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
})
