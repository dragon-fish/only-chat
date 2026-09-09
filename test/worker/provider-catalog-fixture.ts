import { env } from 'cloudflare:workers'
import { vi } from 'vitest'
import { createApp } from '@/server/app'
import type { ProviderWithInterfaces } from '@/shared/models'
import type { ProviderWriteInput } from '@/shared/api'
import { ensureTestUser } from './auth-helper'

export const catalogFixture = {
  providers: {
    gateway: { id: 'gateway', name: 'Gateway', api: 'https://gateway.test/v1', models: {
      'lab/alpha': { id: 'lab/alpha', name: 'Operator alpha', tool_call: false, limit: { context: 100 }, cost: { input: 3 } },
      'catalog-only': { id: 'catalog-only', name: 'Never import' },
    } },
    messages: { id: 'messages', name: 'Gateway Messages', api: 'https://gateway.test/messages', models: {} },
    lab: { id: 'lab', name: 'Research Lab', api: 'https://lab.test/v1', models: {
      alpha: { id: 'alpha', name: 'Lab alpha', tool_call: true, limit: { context: 900 }, cost: { input: 90 },
        modalities: { input: ['text', 'image'], output: ['text'] }, reasoning_options: [{ type: 'toggle' as const }] },
    } },
  },
  models: { 'lab/alpha': { id: 'lab/alpha', name: 'Global alpha', reasoning: true, limit: { context: 200 }, cost: { input: 2 } } },
}

export async function catalogApp() {
  const client = await ensureTestUser()
  await env.DB.exec('DELETE FROM model_catalog_refresh')
  const ctx = await createApp({ env, side: 'worker' })
  vi.stubGlobal('fetch', async () => Response.json(catalogFixture))
  await ctx.modelCatalog.refresh('manual')
  vi.unstubAllGlobals()
  const request = (method: string, path: string, body?: unknown) => ctx.api.request(`/api${path}`, {
    method, headers: { 'content-type': 'application/json', cookie: client.cookie }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  async function createProvider(patch: Partial<ProviderWriteInput> = {}): Promise<ProviderWithInterfaces> {
    const response = await request('POST', '/providers', {
      name: 'Gateway', interfaces: [{ protocol: 'responses', base_url: 'https://gateway.test/v1' }],
      default_protocol: 'responses', ...patch,
    })
    if (response.status !== 201) throw new Error(`Provider creation failed: ${await response.text()}`)
    return await response.json() as ProviderWithInterfaces
  }
  return { ctx, request, createProvider }
}
