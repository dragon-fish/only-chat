import type { Context } from 'cordis'
import { Hono, type Context as HonoContext } from 'hono'
import { auth } from '@ai-sdk/mcp'
import type { McpServerRow } from '@/server/db/schema'
import { authUserId, type ApiEnv } from '@/server/plugins/api/auth'
import { McpServerCreateSchema, McpServerPatchSchema, type McpToolsResponse } from '@/shared/mcp'
import { MCP_PLUGIN_ID } from '../shared'
import { classifyMcpError, mcpFetch, mcpToolList, type McpDeps } from './connection'
import { McpOAuthProvider, oauthStateKey, type PendingMcpAuthorization } from './oauth'
import { McpInputError, McpServerStore, mcpServerView } from './store'

const CALLBACK_PATH = `/api/plugins/${MCP_PLUGIN_ID}/oauth/callback`

/** One problem message; zod's first issue is the one the form can point at. */
function problem(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? '输入无效。'
}

/**
 * Status codes are chosen with the client in mind: a 401 from any `/api` route signs the person
 * out, so an MCP server refusing us is reported as 502, never passed through as 401.
 */
function failure(c: HonoContext<ApiEnv>, error: unknown) {
  if (error instanceof McpInputError) return c.json({ error: error.message }, 400)
  return c.json({ error: classifyMcpError(error).message }, 502)
}

/** Connects once and records the outcome on the row; a failure is kept there, not thrown. */
async function probe(deps: McpDeps, row: McpServerRow): Promise<void> {
  await mcpToolList(deps, row, { fresh: true }).catch(() => {})
}

function toolsResponse(row: McpServerRow, list: Awaited<ReturnType<typeof mcpToolList>>): McpToolsResponse {
  return {
    tools: list.tools.map(entry => ({ name: entry.name, description: entry.description, enabled: !row.disabled_tools.includes(entry.name) })),
    instructions: list.instructions,
  }
}

function callbackPage(ok: boolean, key: string | null, message: string): Response {
  const payload = JSON.stringify({ ok, key })
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP 授权</title><style>body{font:15px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;color:#222;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}</style></head>
<body><p>${message.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!)}</p>
<script>try{new BroadcastChannel('mcp-oauth').postMessage(${payload})}catch(e){}</script></body></html>`
  return new Response(html, { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

export function mcpRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  const store = new McpServerStore(ctx.db.orm, ctx.env.KEY_ENCRYPTION_SECRET, import.meta.env.DEV)
  const deps: McpDeps = { store, kv: ctx.env.KV }

  async function owned(c: HonoContext<ApiEnv>): Promise<McpServerRow | null> {
    return (await store.get(authUserId(c), c.req.param('key') ?? '')) ?? null
  }

  r.get('/servers', async (c) => {
    return c.json({ servers: (await store.list(authUserId(c))).map(mcpServerView) })
  })

  r.post('/servers', async (c) => {
    const parsed = McpServerCreateSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: problem(parsed.error) }, 400)
    try {
      const row = await store.create(authUserId(c), parsed.data)
      await probe(deps, row)
      return c.json({ server: mcpServerView(row) }, 201)
    } catch (error) { return failure(c, error) }
  })

  r.patch('/servers/:key', async (c) => {
    const parsed = McpServerPatchSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: problem(parsed.error) }, 400)
    try {
      const before = await owned(c)
      if (!before) return c.json({ error: '找不到这个 MCP 服务。' }, 404)
      const row = await store.patch(authUserId(c), before.key, parsed.data)
      // Only a change to how the server is reached is worth a round trip to it.
      if (row.config_version !== before.config_version) await probe(deps, row)
      return c.json({ server: mcpServerView(row) })
    } catch (error) { return failure(c, error) }
  })

  r.delete('/servers/:key', async (c) => {
    const removed = await store.remove(authUserId(c), c.req.param('key'))
    return removed ? c.body(null, 204) : c.json({ error: '找不到这个 MCP 服务。' }, 404)
  })

  r.get('/servers/:key/tools', async (c) => {
    const row = await owned(c)
    if (!row) return c.json({ error: '找不到这个 MCP 服务。' }, 404)
    try { return c.json(toolsResponse(row, await mcpToolList(deps, row))) }
    catch (error) { return failure(c, error) }
  })

  r.post('/servers/:key/refresh', async (c) => {
    const row = await owned(c)
    if (!row) return c.json({ error: '找不到这个 MCP 服务。' }, 404)
    try {
      const bumped = await store.bumpVersion(row)
      return c.json(toolsResponse(bumped, await mcpToolList(deps, bumped, { fresh: true })))
    } catch (error) { return failure(c, error) }
  })

  /** Starts OAuth: registers a client when the server needs one and hands back where to sign in. */
  r.post('/servers/:key/authorize', async (c) => {
    const row = await owned(c)
    if (!row) return c.json({ error: '找不到这个 MCP 服务。' }, 404)
    // Derived from this request, never configured: a pinned origin would send local sign-ins to production.
    const redirectUrl = new URL(CALLBACK_PATH, c.req.url).toString()
    const provider = new McpOAuthProvider(store, row, { kind: 'authorize', redirectUrl, kv: ctx.env.KV, userId: row.user_id })
    try {
      const result = await auth(provider, { serverUrl: row.url, fetchFn: mcpFetch })
      if (result === 'AUTHORIZED') {
        const bumped = await store.bumpVersion(row)
        await probe(deps, bumped)
        return c.json({ authorized: true, server: mcpServerView((await store.get(row.user_id, row.key))!) })
      }
      if (!provider.authorizationUrl) throw new Error('授权服务器没有给出授权地址。')
      return c.json({ authorization_url: provider.authorizationUrl.toString() })
    } catch (error) {
      console.error('mcp authorize failed', row.key, error)
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: `无法开始授权：${message.slice(0, 300)}` }, 502)
    }
  })

  r.get('/oauth/callback', async (c) => {
    const state = c.req.query('state')
    const code = c.req.query('code')
    if (!state) return callbackPage(false, null, '授权回调缺少 state，请回到设置页重新授权。')
    const pending = await ctx.env.KV.get<PendingMcpAuthorization>(oauthStateKey(state), 'json')
    // Another account's state is treated as missing: which server it names is none of this user's business.
    if (!pending || pending.userId !== authUserId(c)) return callbackPage(false, null, '授权已过期或无效，请回到设置页重新授权。')
    await ctx.env.KV.delete(oauthStateKey(state))
    const row = await store.get(pending.userId, pending.key)
    if (!row) return callbackPage(false, null, '这个 MCP 服务已经被删除。')
    const denied = c.req.query('error')
    if (denied || !code) return callbackPage(false, row.key, `授权没有完成：${c.req.query('error_description') ?? denied ?? '缺少授权码'}`)

    const provider = new McpOAuthProvider(store, row, { kind: 'callback', codeVerifier: pending.codeVerifier, state })
    try {
      await auth(provider, { serverUrl: row.url, authorizationCode: code, callbackState: state, callbackIssuer: c.req.query('iss'), fetchFn: mcpFetch })
      const bumped = await store.bumpVersion(row)
      await probe(deps, bumped)
      return callbackPage(true, row.key, '授权完成，可以关闭此窗口。')
    } catch (error) {
      console.error('mcp oauth callback failed', row.key, error)
      const message = error instanceof Error ? error.message : String(error)
      return callbackPage(false, row.key, `换取令牌失败：${message.slice(0, 300)}`)
    }
  })

  return r
}

/** The Worker half: settings and OAuth. The tools run in the UserHub, a different cordis root. */
export const McpApiPlugin = {
  name: 'mcp-api',
  inject: ['pluginApi', 'db', 'env'] as const,
  apply(ctx: Context) {
    ctx.pluginApi.register(MCP_PLUGIN_ID, mcpRoutes(ctx))
  },
}
