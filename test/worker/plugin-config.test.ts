import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { pluginConfigs } from '@/server/db/schema'
import { createApp } from '@/server/app'
import { COMFYUI_PLUGIN_ID, TAVILY_PLUGIN_ID } from '@/shared/plugins'
import type { PluginConfigStatusMap } from '@/shared/plugins'
import { ensureTestUser, authenticatedFetch } from './auth-helper'

let userId: number
beforeEach(async () => {
  const client = await ensureTestUser()
  const session = await (await client.request('/api/auth/get-session')).json() as { user: { id: string } }
  userId = Number(session.user.id)
  await createDb(env.DB).delete(pluginConfigs).where(eq(pluginConfigs.user_id, userId))
})

const json = (method: string, path: string, body?: unknown) =>
  authenticatedFetch(new Request(`https://x${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))

const storedValue = async (key: string) => {
  const [row] = await createDb(env.DB).select().from(pluginConfigs).where(and(
    eq(pluginConfigs.user_id, userId),
    eq(pluginConfigs.plugin_id, TAVILY_PLUGIN_ID),
    eq(pluginConfigs.key, key),
  ))
  return row?.value
}

describe('plugin configuration', () => {
  it('reports an unconfigured plugin rather than failing', async () => {
    const me = await (await json('GET', '/api/me')).json() as { plugin_config: PluginConfigStatusMap }
    expect(me.plugin_config[TAVILY_PLUGIN_ID]).toEqual({ configured: false, values: {}, secrets: { api_key: false } })
  })

  it('stores the API key encrypted and never returns it', async () => {
    const response = await json('PUT', `/api/plugins/${TAVILY_PLUGIN_ID}/config`, {
      api_key: 'tvly-secret-value',
      search_depth: 'advanced',
      search_calls_per_turn: 4,
      extract_calls_per_turn: 2,
    })
    expect(response.status).toBe(200)
    const status = await response.json() as PluginConfigStatusMap

    expect(status[TAVILY_PLUGIN_ID]).toEqual({
      configured: true,
      values: { search_depth: 'advanced', search_calls_per_turn: 4, extract_calls_per_turn: 2 },
      secrets: { api_key: true },
    })
    expect(JSON.stringify(status)).not.toContain('tvly-secret-value')

    const ciphertext = await storedValue('api_key')
    expect(ciphertext).toBeDefined()
    expect(ciphertext).not.toContain('tvly-secret-value')

    const ctx = await createApp({ env, side: 'worker' })
    expect(await ctx.pluginConfig.read(userId, TAVILY_PLUGIN_ID)).toMatchObject({ api_key: 'tvly-secret-value' })
  })

  it('keeps the stored key when a later save omits it', async () => {
    await json('PUT', `/api/plugins/${TAVILY_PLUGIN_ID}/config`, { api_key: 'tvly-original' })
    const before = await storedValue('api_key')

    const response = await json('PUT', `/api/plugins/${TAVILY_PLUGIN_ID}/config`, { search_calls_per_turn: 7 })
    expect(response.status).toBe(200)

    const ctx = await createApp({ env, side: 'worker' })
    expect(await ctx.pluginConfig.read(userId, TAVILY_PLUGIN_ID)).toMatchObject({
      api_key: 'tvly-original',
      search_calls_per_turn: 7,
    })
    // Re-encrypting an unchanged secret is allowed; losing it is not.
    expect(before).toBeDefined()
  })

  it('rejects an invalid value without writing anything', async () => {
    const response = await json('PUT', `/api/plugins/${TAVILY_PLUGIN_ID}/config`, { api_key: '' })
    expect(response.status).toBe(400)
    expect(await storedValue('api_key')).toBeUndefined()
  })

  it('404s a plugin that declares no configuration', async () => {
    expect((await json('PUT', '/api/plugins/ask_user/config', {})).status).toBe(404)
    expect((await json('PUT', '/api/plugins/nope/config', {})).status).toBe(404)
  })

  describe('key-value rows', () => {
    const headers = (rows: unknown) => json('PUT', `/api/plugins/${COMFYUI_PLUGIN_ID}/config`, { base_url: 'https://comfy.example', headers: rows })
    const storedHeaders = async () => {
      const [row] = await createDb(env.DB).select().from(pluginConfigs).where(and(
        eq(pluginConfigs.user_id, userId), eq(pluginConfigs.plugin_id, COMFYUI_PLUGIN_ID), eq(pluginConfigs.key, 'headers'),
      ))
      return row?.value
    }

    it('encrypts only the rows marked secret and never returns their values', async () => {
      const response = await headers([
        { name: 'CF-Access-Client-Secret', value: 'cf-secret-value', secret: true },
        { name: 'X-Region', value: 'hk', secret: false },
      ])
      expect(response.status).toBe(200)
      const status = await response.json() as PluginConfigStatusMap
      expect(status[COMFYUI_PLUGIN_ID]!.values.headers).toEqual([
        { name: 'CF-Access-Client-Secret', value: null, secret: true },
        { name: 'X-Region', value: 'hk', secret: false },
      ])
      expect(await storedHeaders()).not.toContain('cf-secret-value')
      const ctx = await createApp({ env, side: 'worker' })
      expect((await ctx.pluginConfig.read(userId, COMFYUI_PLUGIN_ID)).headers).toEqual([
        { name: 'CF-Access-Client-Secret', value: 'cf-secret-value', secret: true },
        { name: 'X-Region', value: 'hk', secret: false },
      ])
    })

    it('keeps a saved secret sent back as null, under its own name only', async () => {
      await headers([{ name: 'Authorization', value: 'Basic abc', secret: true }])
      expect((await headers([{ name: 'Authorization', value: null, secret: true }, { name: 'X-Extra', value: '1', secret: false }])).status).toBe(200)
      const ctx = await createApp({ env, side: 'worker' })
      expect((await ctx.pluginConfig.read(userId, COMFYUI_PLUGIN_ID)).headers)
        .toEqual([{ name: 'Authorization', value: 'Basic abc', secret: true }, { name: 'X-Extra', value: '1', secret: false }])

      const renamed = await headers([{ name: 'Proxy-Authorization', value: null, secret: true }])
      expect(renamed.status).toBe(400)
      expect(await renamed.json()).toEqual({ error: '请填写 Proxy-Authorization 的值' })
    })
  })
})

