import { env } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '@/server/db/client'
import { mcpServers } from '@/server/db/schema'
import { decryptSecret } from '@/server/plugins/llm/crypto'
import type { ToolContext } from '@/server/plugins/tools'
import { callToolTool, listServicesTool, listToolsTool } from '@/plugins/mcp/server'
import { oauthStateKey } from '@/plugins/mcp/server/oauth'
import type { McpServerView, McpToolsResponse } from '@/shared/mcp'
import { authenticatedFetch, ensureTestUser } from './auth-helper'
import { FAKE_MCP_URL, fakeMcpServer, type FakeMcpServer } from './mcp-fake-server'

const API = '/api/plugins/mcp'
const db = createDb(env.DB)
let userId: number
let server: FakeMcpServer

const request = (method: string, path: string, body?: unknown) =>
  authenticatedFetch(new Request(`https://chat.test${API}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }))

async function createServer(body: Record<string, unknown> = {}): Promise<McpServerView> {
  const response = await request('POST', '/servers', { name: 'Fake', url: FAKE_MCP_URL, ...body })
  expect(response.status).toBe(201)
  return (await response.json() as { server: McpServerView }).server
}

beforeEach(async () => {
  const client = await ensureTestUser()
  const session = await (await client.request('/api/auth/get-session')).json() as { user: { id: string } }
  userId = Number(session.user.id)
  await db.delete(mcpServers)
  server = fakeMcpServer()
  vi.stubGlobal('fetch', server.fetch)
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('MCP server settings', () => {
  it('stores a secret header encrypted, never returns it, and sends it decrypted', async () => {
    server.requireHeader = { name: 'authorization', value: 'Bearer sk-live' }
    const created = await createServer({ headers: [
      { name: 'Authorization', value: 'Bearer sk-live', secret: true },
      { name: 'X-Region', value: 'cn', secret: false },
    ] })

    expect(created.status).toBe('ok')
    expect(created.headers).toEqual([
      { name: 'Authorization', value: null, secret: true },
      { name: 'X-Region', value: 'cn', secret: false },
    ])
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.key, created.key))
    expect(row!.headers[0]!.value).not.toContain('sk-live')
    expect(await decryptSecret(env.KEY_ENCRYPTION_SECRET, row!.headers[0]!.value)).toBe('Bearer sk-live')
    expect(server.requests.at(-1)!.headers.get('x-region')).toBe('cn')
  })

  it('keeps a saved secret when the form sends no value, but not when it turns plain', async () => {
    const created = await createServer({ headers: [{ name: 'X-API-Key', value: 'k1', secret: true }] })
    const kept = await request('PATCH', `/servers/${created.key}`, { headers: [{ name: 'X-API-Key', value: null, secret: true }] })
    expect(kept.status).toBe(200)
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.key, created.key))
    expect(await decryptSecret(env.KEY_ENCRYPTION_SECRET, row!.headers[0]!.value)).toBe('k1')

    const exposed = await request('PATCH', `/servers/${created.key}`, { headers: [{ name: 'X-API-Key', value: null, secret: false }] })
    expect(exposed.status).toBe(400)
  })

  it('lists tools with their switches and honours a disabled one', async () => {
    const created = await createServer()
    expect((await request('PATCH', `/servers/${created.key}`, { disabled_tools: ['delete_page'] })).status).toBe(200)
    const listed = await (await request('GET', `/servers/${created.key}/tools`)).json() as McpToolsResponse
    expect(listed.instructions).toBe('Search first, then retrieve.')
    expect(listed.tools.map(tool => [tool.name, tool.enabled])).toEqual([['search', true], ['retrieve_page', true], ['delete_page', false]])
  })

  it('reports a server that refuses us as needing authorization, never as our own 401', async () => {
    server.requireBearer = 'fake-access'
    const created = await createServer()
    expect(created.status).toBe('needs_auth')
    const tools = await request('GET', `/servers/${created.key}/tools`)
    expect(tools.status).toBe(502)
  })

  it('refuses plain http and more than the per-user limit', async () => {
    expect((await request('POST', '/servers', { name: 'Plain', url: 'http://mcp.fake.test/mcp' })).status).toBe(400)
    const now = Date.now()
    for (let i = 0; i < 20; i++) {
      await db.insert(mcpServers).values({ user_id: userId, key: `k${String(i).padStart(7, '0')}`, name: `s${i}`, url: FAKE_MCP_URL, created_at: now, updated_at: now })
    }
    expect((await request('POST', '/servers', { name: 'One more', url: FAKE_MCP_URL })).status).toBe(400)
  })
})

describe('MCP OAuth', () => {
  it('registers, sends the person to sign in, and stores the tokens the callback exchanges', async () => {
    server.requireBearer = 'fake-access'
    const created = await createServer()
    const started = await (await request('POST', `/servers/${created.key}/authorize`)).json() as { authorization_url: string }
    const authorizationUrl = new URL(started.authorization_url)
    expect(authorizationUrl.origin).toBe('https://mcp.fake.test')
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('https://chat.test/api/plugins/mcp/oauth/callback')
    const state = authorizationUrl.searchParams.get('state')!

    const wrong = await authenticatedFetch(new Request(`https://chat.test${API}/oauth/callback?code=good-code&state=not-the-state`))
    expect(wrong.status).toBe(400)

    const done = await authenticatedFetch(new Request(`https://chat.test${API}/oauth/callback?code=good-code&state=${state}`))
    expect(done.status).toBe(200)
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.key, created.key))
    expect(row!.status).toBe('ok')
    const oauth = JSON.parse(await decryptSecret(env.KEY_ENCRYPTION_SECRET, row!.oauth!)) as { tokens: { access_token: string } }
    expect(oauth.tokens.access_token).toBe('fake-access')
    expect(await env.KV.get(oauthStateKey(state))).toBeNull()
  })

  it('refuses a callback whose state belongs to another account', async () => {
    const created = await createServer()
    await env.KV.put(oauthStateKey('foreign'), JSON.stringify({ userId: userId + 1000, key: created.key, codeVerifier: 'v' }))
    const response = await authenticatedFetch(new Request(`https://chat.test${API}/oauth/callback?code=good-code&state=foreign`))
    expect(response.status).toBe(400)
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.key, created.key))
    expect(row!.oauth).toBeNull()
  })
})

describe('MCP tools', () => {
  const ctx = { env } as unknown as Context
  const runtime = () => ({
    userId, db, assets: {}, turn: new Map(), signal: new AbortController().signal,
    acceptsImages: false, acceptsToolResultImages: false,
  }) as unknown as ToolContext
  const run = (tool: { execute?: unknown }, input: unknown) =>
    (tool.execute as (input: unknown, options: unknown) => Promise<any>)(input, { toolCallId: 'call-1', messages: [] })

  it('lists services with a preview, reads tools by keyword, and calls one', async () => {
    const created = await createServer()
    await request('PATCH', `/servers/${created.key}`, { disabled_tools: ['delete_page'] })
    const turn = runtime()

    const services = await run(listServicesTool(ctx, turn), {})
    expect(services.services).toEqual([{ service_id: created.key, name: 'Fake', tool_count: 2, tools_preview: ['search', 'retrieve_page'] }])

    const tools = await run(listToolsTool(ctx, turn), { service_id: created.key, query: 'page_id' })
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual(['retrieve_page'])
    expect(tools.instructions).toBe('Search first, then retrieve.')

    const result = await run(callToolTool(ctx, turn), { service_id: created.key, tool_name: 'search', params: { query: 'x' } })
    expect(result).toMatchObject({ is_error: false, text: 'found: page-1' })
    expect(server.calls).toEqual([{ name: 'search', arguments: { query: 'x' } }])

    const failed = await run(callToolTool(ctx, turn), { service_id: created.key, tool_name: 'retrieve_page', params: {} })
    expect(failed).toMatchObject({ is_error: true, text: 'no such page' })
  })

  it('refuses a disabled tool, an unknown tool and an unknown service without reaching the server', async () => {
    const created = await createServer()
    await request('PATCH', `/servers/${created.key}`, { disabled_tools: ['delete_page'] })
    const call = callToolTool(ctx, runtime())
    expect(await run(call, { service_id: created.key, tool_name: 'delete_page', params: {} })).toMatchObject({ error: 'TOOL_DISABLED' })
    expect(await run(call, { service_id: created.key, tool_name: 'nope', params: {} })).toMatchObject({ error: 'TOOL_NOT_FOUND' })
    expect(await run(call, { service_id: 'missing1', tool_name: 'search', params: {} })).toMatchObject({ error: 'SERVICE_NOT_FOUND' })
    expect(server.calls).toEqual([])
  })
})
