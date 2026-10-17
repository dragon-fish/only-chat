import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { pluginConfigs, providers, users } from '@/server/db/schema'
import { createApp } from '@/server/app'
import { COMFYUI_PLUGIN_ID, WEB_SEARCH_PLUGIN_ID } from '@/shared/plugins'
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
    eq(pluginConfigs.plugin_id, WEB_SEARCH_PLUGIN_ID),
    eq(pluginConfigs.key, key),
  ))
  return row?.value
}

describe('plugin configuration', () => {
  it('reports an unconfigured plugin rather than failing', async () => {
    const me = await (await json('GET', '/api/me')).json() as { plugin_config: PluginConfigStatusMap }
    expect(me.plugin_config[WEB_SEARCH_PLUGIN_ID]).toEqual({ configured: false, values: {}, secrets: { deepseek_api_key: false, tavily_api_key: false } })
  })

  it('stores the API key encrypted and never returns it', async () => {
    const response = await json('PUT', `/api/plugins/${WEB_SEARCH_PLUGIN_ID}/config`, {
      backend: 'tavily',
      tavily_api_key: 'tvly-secret-value',
      tavily_search_depth: 'advanced',
      search_calls_per_turn: 4,
      extract_calls_per_turn: 2,
    })
    expect(response.status).toBe(200)
    const status = await response.json() as PluginConfigStatusMap

    expect(status[WEB_SEARCH_PLUGIN_ID]).toEqual({
      configured: true,
      values: { backend: 'tavily', deepseek_provider_id: null, tavily_search_depth: 'advanced', search_calls_per_turn: 4, extract_calls_per_turn: 2 },
      secrets: { deepseek_api_key: false, tavily_api_key: true },
    })
    expect(JSON.stringify(status)).not.toContain('tvly-secret-value')

    const ciphertext = await storedValue('tavily_api_key')
    expect(ciphertext).toBeDefined()
    expect(ciphertext).not.toContain('tvly-secret-value')

    const ctx = await createApp({ env, side: 'worker' })
    expect(await ctx.pluginConfig.read(userId, WEB_SEARCH_PLUGIN_ID)).toMatchObject({ tavily_api_key: 'tvly-secret-value' })
  })

  it('keeps the stored key when a later save omits it', async () => {
    await json('PUT', `/api/plugins/${WEB_SEARCH_PLUGIN_ID}/config`, { backend: 'tavily', tavily_api_key: 'tvly-original' })
    const before = await storedValue('tavily_api_key')

    const response = await json('PUT', `/api/plugins/${WEB_SEARCH_PLUGIN_ID}/config`, { search_calls_per_turn: 7 })
    expect(response.status).toBe(200)

    const ctx = await createApp({ env, side: 'worker' })
    expect(await ctx.pluginConfig.read(userId, WEB_SEARCH_PLUGIN_ID)).toMatchObject({
      tavily_api_key: 'tvly-original',
      search_calls_per_turn: 7,
    })
    // Re-encrypting an unchanged secret is allowed; losing it is not.
    expect(before).toBeDefined()
  })

  it('rejects an invalid value without writing anything', async () => {
    const response = await json('PUT', `/api/plugins/${WEB_SEARCH_PLUGIN_ID}/config`, { backend: 'tavily', tavily_api_key: '' })
    expect(response.status).toBe(400)
    expect(await storedValue('tavily_api_key')).toBeUndefined()
  })

  it('requires the credential of the live backend only', async () => {
    expect((await json('PUT', `/api/plugins/${WEB_SEARCH_PLUGIN_ID}/config`, { backend: 'deepseek', tavily_api_key: 'tvly-k' })).status).toBe(400)
    expect((await json('PUT', `/api/plugins/${WEB_SEARCH_PLUGIN_ID}/config`, { backend: 'tavily', tavily_api_key: 'tvly-k' })).status).toBe(200)
  })

  describe('provider references', () => {
    const deepseekInterfaces = [{ protocol: 'chat-completions', base_url: 'https://api.deepseek.com/v1' }]
    const createProvider = async (name: string, baseUrl: string, apiKey?: string) => {
      const response = await json('POST', '/api/providers', {
        name,
        interfaces: [{ protocol: 'chat-completions', base_url: baseUrl }],
        default_protocol: 'chat-completions',
        ...(apiKey ? { api_key: apiKey } : {}),
      })
      expect(response.ok).toBe(true)
      return (await response.json() as { id: number }).id
    }
    const choose = (providerId: number, extra: Record<string, unknown> = {}) =>
      json('PUT', `/api/plugins/${WEB_SEARCH_PLUGIN_ID}/config`, { backend: 'deepseek', deepseek_provider_id: providerId, ...extra })

    it('lends a chosen DeepSeek provider its key, as the key is now', async () => {
      const providerId = await createProvider('DeepSeek', 'https://api.deepseek.com/v1', 'sk-first')
      const response = await choose(providerId)
      expect(response.status).toBe(200)
      expect((await response.json() as PluginConfigStatusMap)[WEB_SEARCH_PLUGIN_ID]?.configured).toBe(true)

      const ctx = await createApp({ env, side: 'worker' })
      expect(await ctx.pluginConfig.providerCredentials(userId, WEB_SEARCH_PLUGIN_ID, 'deepseek_provider_id', providerId))
        .toMatchObject({ apiKey: 'sk-first' })

      const rotated = await json('PUT', `/api/providers/${providerId}`, {
        name: 'DeepSeek', interfaces: deepseekInterfaces, default_protocol: 'chat-completions', api_key: 'sk-rotated',
      })
      expect(rotated.ok).toBe(true)
      expect(await ctx.pluginConfig.providerCredentials(userId, WEB_SEARCH_PLUGIN_ID, 'deepseek_provider_id', providerId))
        .toMatchObject({ apiKey: 'sk-rotated' })
    })

    it('refuses a provider on another host, or one without a key', async () => {
      const relay = await createProvider('Relay', 'https://relay.example/v1', 'sk-relay')
      const keyless = await createProvider('DeepSeek', 'https://api.deepseek.com/v1')
      expect((await choose(relay)).status).toBe(400)
      expect((await choose(keyless)).status).toBe(400)
      expect(await storedValue('deepseek_provider_id')).toBeUndefined()
    })

    it("refuses another user's provider", async () => {
      const db = createDb(env.DB)
      const [other] = await db.insert(users).values({
        name: 'other', email: `${crypto.randomUUID()}@example.com`, settings: { plugins: {} }, createdAt: new Date(0), updatedAt: new Date(0),
      }).returning()
      const [foreign] = await db.insert(providers).values({ user_id: other!.id, name: 'theirs', created_at: 0 }).returning()
      expect((await choose(foreign!.id)).status).toBe(400)
    })

    it('stops counting as configured once the provider is deleted, unless another backend is live', async () => {
      const providerId = await createProvider('DeepSeek', 'https://api.deepseek.com/v1', 'sk-ds')
      expect((await choose(providerId, { tavily_api_key: 'tvly-k' })).status).toBe(200)
      expect((await json('DELETE', `/api/providers/${providerId}`)).ok).toBe(true)

      const ctx = await createApp({ env, side: 'worker' })
      expect(await ctx.pluginConfig.isConfigured(userId, WEB_SEARCH_PLUGIN_ID)).toBe(false)
      await expect(ctx.pluginConfig.read(userId, WEB_SEARCH_PLUGIN_ID)).rejects.toThrow('所选供应商')

      // The dangling reference sits behind a backend nobody uses, so it does not block Tavily.
      expect((await json('PUT', `/api/plugins/${WEB_SEARCH_PLUGIN_ID}/config`, { backend: 'tavily' })).status).toBe(200)
      expect(await ctx.pluginConfig.isConfigured(userId, WEB_SEARCH_PLUGIN_ID)).toBe(true)
    })
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

