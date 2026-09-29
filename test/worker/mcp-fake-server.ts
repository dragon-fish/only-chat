/**
 * A minimal Streamable HTTP MCP server and OAuth authorization server behind one fetch function,
 * for `vi.stubGlobal('fetch', …)`. JSON responses only: the SDK accepts them in place of SSE.
 */
export interface FakeMcpServer {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Every MCP request the server received, for asserting what reached it. */
  requests: Array<{ headers: Headers }>
  calls: Array<{ name: string, arguments: unknown }>
  /** When set, MCP requests without `Authorization: Bearer <token>` get 401. */
  requireBearer: string | null
  /** When set, MCP requests whose header does not match get 401. */
  requireHeader: { name: string, value: string } | null
}

export const FAKE_ORIGIN = 'https://mcp.fake.test'
export const FAKE_MCP_URL = `${FAKE_ORIGIN}/mcp`

export const FAKE_TOOLS = [
  { name: 'search', description: 'Search pages', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'retrieve_page', description: 'Fetch one page', inputSchema: { type: 'object', properties: { page_id: { type: 'string' } } } },
  { name: 'delete_page', description: 'Delete one page', inputSchema: { type: 'object', properties: { page_id: { type: 'string' } } } },
]

function rpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}

export function fakeMcpServer(): FakeMcpServer {
  const server: FakeMcpServer = {
    requests: [],
    calls: [],
    requireBearer: null,
    requireHeader: null,
    async fetch(input, init) {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== FAKE_ORIGIN) throw new Error(`unexpected outbound fetch to ${request.url}`)

      if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return Response.json({ resource: FAKE_MCP_URL, authorization_servers: [FAKE_ORIGIN] })
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: FAKE_ORIGIN,
          authorization_endpoint: `${FAKE_ORIGIN}/authorize`,
          token_endpoint: `${FAKE_ORIGIN}/token`,
          registration_endpoint: `${FAKE_ORIGIN}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      }
      if (url.pathname === '/register') {
        const body = await request.json() as Record<string, unknown>
        return Response.json({ ...body, client_id: 'fake-client' }, { status: 201 })
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await request.text())
        if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'good-code' && form.get('code_verifier')) {
          return Response.json({ access_token: 'fake-access', token_type: 'Bearer', refresh_token: 'fake-refresh', expires_in: 3600 })
        }
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      if (url.pathname.startsWith('/.well-known/')) return new Response('not found', { status: 404 })
      if (url.pathname !== '/mcp') return new Response('not found', { status: 404 })

      server.requests.push({ headers: request.headers })
      if (server.requireBearer && request.headers.get('authorization') !== `Bearer ${server.requireBearer}`) {
        return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${FAKE_ORIGIN}/.well-known/oauth-protected-resource"` } })
      }
      if (server.requireHeader && request.headers.get(server.requireHeader.name) !== server.requireHeader.value) {
        return new Response('unauthorized', { status: 401 })
      }
      if (request.method === 'GET') return new Response(null, { status: 405 })
      if (request.method === 'DELETE') return new Response(null, { status: 200 })

      const message = await request.json() as { id?: unknown, method: string, params?: Record<string, unknown> }
      if (message.id === undefined) return new Response(null, { status: 202 })
      switch (message.method) {
        case 'initialize':
          return rpc(message.id, {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1.0.0' },
            instructions: 'Search first, then retrieve.',
          })
        case 'tools/list':
          return rpc(message.id, { tools: FAKE_TOOLS })
        case 'tools/call': {
          const name = String(message.params?.name)
          server.calls.push({ name, arguments: message.params?.arguments })
          if (name === 'search') return rpc(message.id, { content: [{ type: 'text', text: 'found: page-1' }] })
          return rpc(message.id, { content: [{ type: 'text', text: 'no such page' }], isError: true })
        }
        default:
          return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
      }
    },
  }
  return server
}
