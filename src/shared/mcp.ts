import { z } from 'zod'

/** Remote transports only: the Worker and the Durable Object cannot spawn a stdio process. */
export const McpTransportSchema = z.enum(['http', 'sse'])
export type McpTransport = z.infer<typeof McpTransportSchema>

/** `unknown` until the first connection attempt settles it. */
export const McpServerStatusSchema = z.enum(['unknown', 'ok', 'needs_auth', 'error'])
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>

export const MCP_MAX_SERVERS = 20

/** As stored: a secret header's `value` is AES-GCM ciphertext and never leaves the server. */
export interface StoredMcpHeader {
  name: string
  value: string
  secret: boolean
}

/**
 * Headers the SDK sets itself. Two copies of one of these would reach the server with whichever the
 * transport merged last, so they are refused rather than silently overridden.
 */
const RESERVED_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const SENSITIVE_WORDS = ['auth', 'token', 'key', 'secret', 'password', 'cookie', 'session', 'credential']
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** The default for a new header row; the person can always flip it. */
export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_WORDS.some(word => lower.includes(word))
}

/**
 * A header as the settings form sends it. `value: null` keeps a saved secret as it is — the form
 * never received the plaintext, so it has nothing to send back.
 */
export const McpHeaderInputSchema = z.object({
  name: z.string().trim().min(1, '请求头缺少名称。').max(128),
  value: z.string().max(8192).nullable(),
  secret: z.boolean(),
})
export type McpHeaderInput = z.infer<typeof McpHeaderInputSchema>

/** Returns the first problem with a set of headers, or null. `oauth` forbids a hand-written Authorization. */
export function mcpHeadersProblem(headers: readonly { name: string }[], options: { oauth: boolean }): string | null {
  const seen = new Set<string>()
  for (const header of headers) {
    const name = header.name.trim()
    if (!HEADER_NAME.test(name)) return `请求头名称 ${name} 不合法。`
    const lower = name.toLowerCase()
    if (RESERVED_HEADERS.includes(lower)) return `${name} 由客户端自动设置，不能在这里填写。`
    if (options.oauth && lower === 'authorization') return '已通过 OAuth 授权的服务不能再填写 Authorization。'
    if (seen.has(lower)) return `请求头 ${name} 重复了。`
    seen.add(lower)
  }
  return null
}

const McpUrlSchema = z.string().trim().url('请输入完整的服务地址。').max(2048)

export const McpServerCreateSchema = z.object({
  name: z.string().trim().min(1, '请填写名称。').max(80),
  url: McpUrlSchema,
  transport: McpTransportSchema.default('http'),
  headers: z.array(McpHeaderInputSchema).max(32).default([]),
})
export type McpServerCreate = z.infer<typeof McpServerCreateSchema>

export const McpServerPatchSchema = z.object({
  name: z.string().trim().min(1, '请填写名称。').max(80).optional(),
  url: McpUrlSchema.optional(),
  transport: McpTransportSchema.optional(),
  headers: z.array(McpHeaderInputSchema).max(32).optional(),
  enabled: z.boolean().optional(),
  disabled_tools: z.array(z.string().min(1).max(256)).max(1000).optional(),
})
export type McpServerPatch = z.infer<typeof McpServerPatchSchema>

/** A header as the API returns it: a secret one carries no value at all. */
export interface McpHeaderView {
  name: string
  value: string | null
  secret: boolean
}

export interface McpServerView {
  key: string
  name: string
  url: string
  transport: McpTransport
  headers: McpHeaderView[]
  enabled: boolean
  disabled_tools: string[]
  /** Whether OAuth credentials are stored; tokens themselves never leave the server. */
  oauth: boolean
  status: McpServerStatus
  last_error: string | null
  updated_at: number
}

export interface McpToolView {
  name: string
  description: string | null
  enabled: boolean
}

export interface McpToolsResponse {
  tools: McpToolView[]
  instructions: string | null
}
