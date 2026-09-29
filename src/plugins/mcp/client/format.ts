import type { McpServerStatus, McpTransport } from '@/shared/mcp'

export const TRANSPORT_LABELS: Record<McpTransport, string> = {
  http: 'Streamable HTTP',
  sse: 'SSE',
}

export const STATUS_LABELS: Record<McpServerStatus, string> = {
  unknown: '未连接',
  ok: '已连接',
  needs_auth: '需要授权',
  error: '出错',
}

export function statusVariant(status: McpServerStatus): 'secondary' | 'outline' | 'destructive' {
  if (status === 'ok') return 'secondary'
  if (status === 'error') return 'destructive'
  return 'outline'
}

/** Posted by the OAuth callback page, which runs in its own window on this origin. */
export const OAUTH_CHANNEL = 'mcp-oauth'
