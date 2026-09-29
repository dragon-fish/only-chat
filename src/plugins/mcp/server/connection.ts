import { createMCPClient, UnauthorizedError, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp'
import type { McpServerRow } from '@/server/db/schema'
import { McpNeedsAuthorization, McpOAuthProvider, type McpOAuthMode } from './oauth'
import type { McpServerStore } from './store'

/** One server's tools as the SDK listed them, plus what it said about itself at initialization. */
export interface McpToolList {
  tools: Array<{ name: string, description: string | null, inputSchema: unknown }>
  instructions: string | null
}

export interface McpDeps {
  store: McpServerStore
  kv: KVNamespace
}

type MCPTransportConfigWithFetch = Extract<MCPClientConfig['transport'], { url: string }> & { fetch: typeof fetch }

const TOOL_LIST_TTL_SECONDS = 3600
const CONNECT_TIMEOUT_MS = 15_000
const MAX_TOOL_PAGES = 20

/** The version is in the key, so a bumped server simply never reads an old entry again. */
const toolListKey = (row: McpServerRow) => `mcp-tools:${row.user_id}:${row.key}:${row.config_version}`

/** A failure worth telling the model and the settings page about, already classified. */
export class McpServerFailure extends Error {
  constructor(readonly status: 'needs_auth' | 'error', message: string) {
    super(message)
  }
}

export function classifyMcpError(error: unknown): McpServerFailure {
  if (error instanceof McpServerFailure) return error
  if (error instanceof McpNeedsAuthorization || error instanceof UnauthorizedError) {
    return new McpServerFailure('needs_auth', new McpNeedsAuthorization().message)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new McpServerFailure('error', message.slice(0, 500) || '连接 MCP 服务失败。')
}

/**
 * Every call goes through here, so the settings page always shows the last thing that happened.
 * A success clears a stale error; a failure is recorded and rethrown classified.
 */
export async function withMcpStatus<T>(store: McpServerStore, row: McpServerRow, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run()
    await store.setStatus(row, 'ok', null)
    return result
  } catch (error) {
    const failure = classifyMcpError(error)
    await store.setStatus(row, failure.status, failure.message)
    throw failure
  }
}

/**
 * Never follows a redirect: doing so would carry the configured headers — API keys among them — to
 * wherever the server pointed. Workers reject `redirect: 'error'` outright, which is the SDK's own
 * default, so every request goes out as `manual` and a 3xx fails here instead.
 */
export const mcpFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`MCP 服务返回了重定向（${response.status}），为保护请求头中的凭据不予跟随。`)
  }
  return response
}

export async function openMcpClient(deps: McpDeps, row: McpServerRow, mode: McpOAuthMode = { kind: 'background' }, signal?: AbortSignal): Promise<MCPClient> {
  return createMCPClient({
    transport: {
      type: row.transport,
      url: row.url,
      headers: await deps.store.requestHeaders(row),
      authProvider: new McpOAuthProvider(deps.store, row, mode),
      // Not in the SDK's config type, but its transports take it and discovery inherits it.
      fetch: mcpFetch,
    } as MCPTransportConfigWithFetch,
    clientName: 'only-chat',
    initializationOptions: { timeout: CONNECT_TIMEOUT_MS, signal },
  })
}

async function listAllTools(client: MCPClient, signal?: AbortSignal): Promise<McpToolList['tools']> {
  const tools: McpToolList['tools'] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools({ params: cursor ? { cursor } : undefined, options: { timeout: CONNECT_TIMEOUT_MS, signal } })
    for (const tool of result.tools) tools.push({ name: tool.name, description: tool.description ?? null, inputSchema: tool.inputSchema })
    cursor = result.nextCursor
    if (!cursor) break
  }
  return tools
}

/**
 * The tool list from KV, or from the server when it is not cached. `client` is reused when the
 * caller already holds one; otherwise a connection is opened for this listing alone.
 */
export async function mcpToolList(
  deps: McpDeps,
  row: McpServerRow,
  options: { client?: () => Promise<MCPClient>, signal?: AbortSignal, fresh?: boolean } = {},
): Promise<McpToolList> {
  if (!options.fresh) {
    const cached = await deps.kv.get<McpToolList>(toolListKey(row), 'json')
    if (cached) return cached
  }
  return withMcpStatus(deps.store, row, async () => {
    const own = options.client === undefined
    const client = own ? await openMcpClient(deps, row, undefined, options.signal) : await options.client!()
    try {
      const list: McpToolList = { tools: await listAllTools(client, options.signal), instructions: client.instructions ?? null }
      await deps.kv.put(toolListKey(row), JSON.stringify(list), { expirationTtl: TOOL_LIST_TTL_SECONDS })
      return list
    } finally {
      if (own) await client.close().catch(() => {})
    }
  })
}
