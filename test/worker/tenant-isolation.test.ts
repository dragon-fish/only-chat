import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachmentProviderFiles, attachments, models, providerInterfaces, providers, users } from '@/server/db/schema'
import { createConversation, getConversation, insertMessage, listMessages } from '@/server/plugins/hub/conversations'
import { createProject } from '@/server/plugins/hub/projects'
import type { ModelPage, ProviderWithInterfaces } from '@/shared/models'
import { registerAndLogin, workerFetch } from './auth-helper'
import { catalogApp } from './provider-catalog-fixture'
import * as remoteModels from '@/server/plugins/llm/list-models'
import * as cleanup from '@/server/plugins/files-cleanup'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
beforeEach(async () => { await env.DB.exec("DELETE FROM users; DELETE FROM sqlite_sequence WHERE name = 'users'") })

async function tenants() {
  const fixture = await catalogApp()
  const bob = await registerAndLogin({ name: 'Bob', email: 'bob@example.com', password: 'a-long-test-password' })
  const bobRow = (await fixture.ctx.db.orm.query.users.findFirst({ where: eq(users.email, 'bob@example.com') }))!
  const aliceRow = (await fixture.ctx.db.orm.query.users.findFirst({ where: eq(users.email, 'owner@example.com') }))!
  const bobRequest = (method: string, path: string, body?: unknown) => fixture.ctx.api.request(`/api${path}`, {
    method, headers: { cookie: bob.cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ...fixture, bob, bobRequest, aliceId: aliceRow.id, bobId: bobRow.id }
}

const providerInput = { name: 'Bob provider', default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://gateway.test/v1' }] }

describe('authenticated REST tenant isolation', () => {
  it('scopes provider and model lists and rejects foreign reads and writes without changing the owner records', async () => {
    const { ctx, request, createProvider, bobRequest, aliceId, bobId } = await tenants()
    const aliceProvider = await createProvider({ api_key: 'alice-secret' })
    const bobProvider = await (await bobRequest('POST', '/providers', providerInput)).json() as ProviderWithInterfaces
    expect.soft(aliceProvider.user_id).toBe(aliceId)
    expect.soft(bobProvider.user_id).toBe(bobId)
    const aliceModel = await (await request('POST', `/providers/${aliceProvider.id}/models`, { model_id: 'alice-model' })).json() as { id: number }
    await bobRequest('POST', `/providers/${bobProvider.id}/models`, { model_id: 'bob-model' })
    expect.soft((await (await request('GET', '/providers')).json() as ProviderWithInterfaces[]).map(row => row.id)).toEqual([aliceProvider.id])
    expect.soft((await (await bobRequest('GET', '/providers')).json() as ProviderWithInterfaces[]).map(row => row.id)).toEqual([bobProvider.id])
    expect.soft((await (await bobRequest('GET', '/models')).json() as ModelPage).models.map(row => row.model_id)).toEqual(['bob-model'])
    expect.soft((await (await bobRequest('GET', `/models?provider_id=${aliceProvider.id}`)).json() as ModelPage).models).toEqual([])
    expect.soft((await (await bobRequest('GET', `/models?interface_id=${aliceProvider.default_interface_id}`)).json() as ModelPage).models).toEqual([])
    expect.soft((await (await request('GET', `/providers/${aliceProvider.id}/models`)).json() as ModelPage).models.map(row => row.id)).toEqual([aliceModel.id])
    const [attachment] = await ctx.db.orm.insert(attachments).values({ user_id: aliceId, sha256: 'remote-fixture', mime: 'image/png', size: 1, r2_key: 'fixture', origin: 'upload', created_at: 0 }).returning()
    await ctx.db.orm.insert(attachmentProviderFiles).values({ attachment_id: attachment!.id, provider_id: aliceProvider.id, file_family: 'openai', base_url: 'https://gateway.test/v1', provider_reference: { openai: 'private-file' }, expires_at: Date.now() + 100_000, created_at: 0 })
    const snapshot = () => Promise.all([
      ctx.db.orm.select().from(providers).orderBy(providers.id),
      ctx.db.orm.select().from(providerInterfaces).orderBy(providerInterfaces.id),
      ctx.db.orm.select().from(models).orderBy(models.id),
      ctx.db.orm.select().from(attachmentProviderFiles).orderBy(attachmentProviderFiles.id),
    ])
    const before = await snapshot()
    const discovery = vi.spyOn(remoteModels, 'listRemoteModels')
    const remoteCleanup = vi.spyOn(cleanup, 'cleanupProviderFilesBeforeChange')
    const remoteFetch = vi.fn(() => { throw new Error('Rejected operations must not contact a provider') })
    vi.stubGlobal('fetch', remoteFetch)
    for (const [method, path, body] of [
      ['GET', `/providers/${aliceProvider.id}/models`],
      ['GET', `/providers/${aliceProvider.id}/models/by-ref?model_id=alice-model`],
      ['POST', `/providers/${aliceProvider.id}/models`, { model_id: 'intruder' }],
      ['PUT', `/providers/${aliceProvider.id}/models/${aliceModel.id}`, { enabled: false }],
      ['PUT', `/providers/${aliceProvider.id}/models/bulk`, { enabled: false }],
      ['DELETE', `/providers/${aliceProvider.id}/models/${aliceModel.id}`],
      ['DELETE', `/providers/${bobProvider.id}/models/${aliceModel.id}`],
      ['PUT', `/providers/${bobProvider.id}/models/${aliceModel.id}`, { enabled: false }],
      ['POST', `/providers/${aliceProvider.id}/fetch-models`],
      ['PUT', `/providers/${aliceProvider.id}`, { ...providerInput, api_key: 'stolen' }],
      ['DELETE', `/providers/${aliceProvider.id}`],
    ] as const) {
      expect.soft((await bobRequest(method, path, body)).status, `${method} ${path}`).toBe(404)
      expect.soft(await snapshot(), `${method} ${path} row preservation`).toEqual(before)
    }
    expect(discovery).not.toHaveBeenCalled()
    expect(remoteCleanup).not.toHaveBeenCalled()
    expect(remoteFetch).not.toHaveBeenCalled()
    expect.soft((await request('GET', `/providers/${aliceProvider.id}/models/by-ref?model_id=alice-model`)).status).toBe(200)
    expect.soft(await ctx.db.orm.query.providers.findFirst({ where: (table, { eq }) => eq(table.id, aliceProvider.id) })).toMatchObject({ user_id: aliceId, credential_version: 1 })
  })

  it('isolates conversation messages and project lists', async () => {
    const { ctx, request, bobRequest, aliceId, bobId } = await tenants()
    const aliceProject = await createProject(ctx.db.orm, { user_id: aliceId, name: 'Alice project' })
    const bobProject = await createProject(ctx.db.orm, { user_id: bobId, name: 'Bob project' })
    const aliceConversation = await createConversation(ctx.db.orm, { user_id: aliceId, title: 'Alice private', provider_id: null, model_id: null, project_id: aliceProject.id })
    const bobConversation = await createConversation(ctx.db.orm, { user_id: bobId, title: 'Bob private', provider_id: null, model_id: null, project_id: bobProject.id })
    const message = await insertMessage(ctx.db.orm, aliceId, { conversation_id: aliceConversation.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'secret' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: Date.now() })
    expect.soft(await (await request('GET', '/projects')).json()).toMatchObject([{ id: aliceProject.id }])
    expect.soft(await (await bobRequest('GET', '/projects')).json()).toEqual([bobProject])
    expect.soft(await (await request('GET', '/conversations')).json()).toEqual([aliceConversation])
    expect.soft(await (await bobRequest('GET', '/conversations')).json()).toEqual([bobConversation])
    expect.soft(await (await request('GET', `/conversations/${aliceConversation.id}/messages`)).json()).toMatchObject([{ id: message.id }])
    expect.soft((await bobRequest('GET', `/conversations/${aliceConversation.id}/messages`)).status).toBe(404)
    expect.soft((await request('GET', `/conversations/${bobConversation.id}/messages`)).status).toBe(404)
    expect.soft(await getConversation(ctx.db.orm, aliceConversation.id, bobId)).toBeUndefined()
    expect.soft(await listMessages(ctx.db.orm, aliceConversation.id, bobId)).toEqual([])
  })

  it('isolates attachment deduplication, downloads, and object keys for identical bytes', async () => {
    const { ctx, request, client: alice, bob, bobRequest, aliceId, bobId } = await tenants()
    const bytes = new Uint8Array([1, 2, 3, 4])
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
    const upload = (client: typeof bob) => client.request(`/api/attachments/${sha}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes })
    const aliceAttachment = await (await upload(alice)).json() as { attachment_id: number }
    // A private browser HTTP cache belongs to the browser, not to the cookie's current user.
    const cache = new Map<string, Response>()
    const browserGet = async (client: typeof bob, path: string) => {
      if (cache.has(path)) return cache.get(path)!.clone()
      const response = await client.request(path)
      if (response.ok && !response.headers.get('cache-control')?.includes('no-store')) cache.set(path, response.clone())
      return response
    }
    const path = `/api/attachments/${aliceAttachment.attachment_id}`
    expect((await browserGet(alice, path)).status).toBe(200)
    expect((await browserGet(bob, path)).status).toBe(404)
    expect.soft(await (await bobRequest('POST', '/attachments/check', { sha256: sha })).json()).toEqual({ exists: false })
    expect.soft((await bob.request(`/api/attachments/${aliceAttachment.attachment_id}`)).status).toBe(404)
    const bobAttachment = await (await upload(bob)).json() as { attachment_id: number }
    expect.soft(bobAttachment.attachment_id).not.toBe(aliceAttachment.attachment_id)
    expect.soft(await (await request('POST', '/attachments/check', { sha256: sha })).json()).toEqual({ exists: true, attachment_id: aliceAttachment.attachment_id })
    expect.soft(await (await bobRequest('POST', '/attachments/check', { sha256: sha })).json()).toEqual({ exists: true, attachment_id: bobAttachment.attachment_id })
    const rows = await ctx.db.orm.select().from(attachments).where(eq(attachments.sha256, sha))
    expect.soft(rows.map(row => [row.user_id, row.r2_key])).toEqual([[aliceId, `${aliceId}/${sha.slice(0, 2)}/${sha}`], [bobId, `${bobId}/${sha.slice(0, 2)}/${sha}`]])
    expect.soft((await bob.request(`/api/attachments/${bobAttachment.attachment_id}`)).status).toBe(200)
    expect.soft((await alice.request(`/api/attachments/${bobAttachment.attachment_id}`)).status).toBe(404)
  })

  it('returns the session identity with that user settings and keeps the shared catalog behind authentication', async () => {
    const { ctx, request, bobRequest, bobId } = await tenants()
    await ctx.db.orm.update(users).set({ settings: { plugins: { bob: true } } }).where(eq(users.id, bobId))
    const me = await (await bobRequest('GET', '/me')).json()
    expect.soft(me).toMatchObject({ id: bobId, name: 'Bob', email: 'bob@example.com', role: 'user', settings: { plugins: { bob: true } } })
    expect.soft(Object.keys(me as object).sort()).toEqual(['created_at', 'email', 'id', 'name', 'role', 'settings'])
    expect.soft((await request('GET', '/model-catalog/status')).status).toBe(200)
    expect.soft(await (await bobRequest('GET', '/model-catalog/status')).json()).toEqual(await (await request('GET', '/model-catalog/status')).json())
    for (const path of ['/model-catalog/status', '/model-catalog/providers', '/model-catalog/refresh/catalog-manual-test']) expect.soft((await workerFetch(`/api${path}`)).status).toBe(401)
    expect.soft((await workerFetch('/api/model-catalog/refresh', { method: 'POST' })).status).toBe(401)
  })
})
