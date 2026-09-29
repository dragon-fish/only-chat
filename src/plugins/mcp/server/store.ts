import { and, eq, sql } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { mcpServers, type McpServerRow } from '@/server/db/schema'
import { decryptSecret, encryptSecret } from '@/server/plugins/llm/crypto'
import {
  MCP_MAX_SERVERS, mcpHeadersProblem, type McpHeaderInput, type McpServerCreate, type McpServerPatch,
  type McpServerStatus, type McpServerView, type StoredMcpHeader,
} from '@/shared/mcp'

export class McpInputError extends Error {}

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Eight characters the model can repeat back reliably; unique per user, enforced by the index. */
function newServerKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map(byte => KEY_ALPHABET[byte % KEY_ALPHABET.length]).join('')
}

/**
 * Plain `https:` everywhere; plain `http:` to this machine only in development, where a local MCP
 * server is the usual thing to test against. Anything else would send headers in the clear.
 */
export function mcpUrlProblem(url: string, dev: boolean): string | null {
  let parsed: URL
  try { parsed = new URL(url) }
  catch { return '服务地址无效。' }
  if (parsed.protocol === 'https:') return null
  if (dev && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) return null
  return '服务地址必须以 https:// 开头。'
}

export class McpServerStore {
  constructor(private readonly db: DB, private readonly secret: string, private readonly dev: boolean) {}

  list(userId: number): Promise<McpServerRow[]> {
    return this.db.select().from(mcpServers).where(eq(mcpServers.user_id, userId)).orderBy(mcpServers.id)
  }

  async get(userId: number, key: string): Promise<McpServerRow | undefined> {
    const [row] = await this.db.select().from(mcpServers)
      .where(and(eq(mcpServers.user_id, userId), eq(mcpServers.key, key))).limit(1)
    return row
  }

  async create(userId: number, input: McpServerCreate): Promise<McpServerRow> {
    const urlProblem = mcpUrlProblem(input.url, this.dev)
    if (urlProblem) throw new McpInputError(urlProblem)
    const [{ count } = { count: 0 }] = await this.db.select({ count: sql<number>`count(*)` }).from(mcpServers)
      .where(eq(mcpServers.user_id, userId))
    if (count >= MCP_MAX_SERVERS) throw new McpInputError(`最多添加 ${MCP_MAX_SERVERS} 个 MCP 服务。`)
    const headers = await this.storeHeaders(input.headers, [], false)
    const now = Date.now()
    // A collision on eight random characters is astronomically rare, but the index would reject it
    // as an opaque failure; one retry with a fresh key turns that into nothing at all.
    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await this.db.insert(mcpServers).values({
          user_id: userId, key: newServerKey(), name: input.name, url: input.url, transport: input.transport,
          headers, created_at: now, updated_at: now,
        }).returning()
        return row!
      } catch (error) {
        if (attempt >= 1) throw error
      }
    }
  }

  /**
   * Anything that changes how the server is reached bumps `config_version`, which is what retires
   * the cached tool list. Credentials follow the address: a new URL is a different server, and
   * sending it the old one's OAuth tokens would hand them to whoever runs it.
   */
  async patch(userId: number, key: string, input: McpServerPatch): Promise<McpServerRow> {
    const row = await this.get(userId, key)
    if (!row) throw new McpInputError('找不到这个 MCP 服务。')
    const urlChanged = input.url !== undefined && input.url !== row.url
    if (urlChanged) {
      const urlProblem = mcpUrlProblem(input.url!, this.dev)
      if (urlProblem) throw new McpInputError(urlProblem)
    }
    const oauth = urlChanged ? null : row.oauth
    const headers = input.headers === undefined ? row.headers : await this.storeHeaders(input.headers, row.headers, oauth !== null)
    const reconnect = urlChanged || input.headers !== undefined || (input.transport !== undefined && input.transport !== row.transport)
    const [updated] = await this.db.update(mcpServers).set({
      name: input.name ?? row.name,
      url: input.url ?? row.url,
      transport: input.transport ?? row.transport,
      headers,
      enabled: input.enabled ?? row.enabled,
      disabled_tools: input.disabled_tools ?? row.disabled_tools,
      oauth,
      ...(reconnect ? { config_version: row.config_version + 1, status: 'unknown' as const, last_error: null } : {}),
      updated_at: Date.now(),
    }).where(eq(mcpServers.id, row.id)).returning()
    return updated!
  }

  async remove(userId: number, key: string): Promise<boolean> {
    const deleted = await this.db.delete(mcpServers)
      .where(and(eq(mcpServers.user_id, userId), eq(mcpServers.key, key))).returning({ id: mcpServers.id })
    return deleted.length > 0
  }

  /** Written only when it changes, so a busy server costs no write per call. */
  async setStatus(row: McpServerRow, status: McpServerStatus, error: string | null): Promise<void> {
    if (row.status === status && row.last_error === error) return
    await this.db.update(mcpServers).set({ status, last_error: error })
      .where(eq(mcpServers.id, row.id))
    row.status = status
    row.last_error = error
  }

  async bumpVersion(row: McpServerRow): Promise<McpServerRow> {
    const [updated] = await this.db.update(mcpServers)
      .set({ config_version: sql`${mcpServers.config_version} + 1`, updated_at: Date.now() })
      .where(eq(mcpServers.id, row.id)).returning()
    return updated!
  }

  async readOAuth<T>(row: McpServerRow): Promise<T | null> {
    return row.oauth === null ? null : JSON.parse(await decryptSecret(this.secret, row.oauth)) as T
  }

  async writeOAuth(row: McpServerRow, value: unknown | null): Promise<void> {
    const oauth = value === null ? null : await encryptSecret(this.secret, JSON.stringify(value))
    await this.db.update(mcpServers).set({ oauth }).where(eq(mcpServers.id, row.id))
    row.oauth = oauth
  }

  /** The headers to send, secrets decrypted. */
  async requestHeaders(row: McpServerRow): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const header of row.headers) {
      out[header.name] = header.secret ? await decryptSecret(this.secret, header.value) : header.value
    }
    return out
  }

  /**
   * A row with `value: null` keeps what was stored under that name — the form never had the
   * plaintext. Keeping is only possible while it stays secret: turning a secret header plain needs
   * a value typed in, or the stored ciphertext would be shown as if it were the header.
   */
  private async storeHeaders(input: readonly McpHeaderInput[], previous: readonly StoredMcpHeader[], oauth: boolean): Promise<StoredMcpHeader[]> {
    const problem = mcpHeadersProblem(input, { oauth })
    if (problem) throw new McpInputError(problem)
    const out: StoredMcpHeader[] = []
    for (const header of input) {
      const name = header.name.trim()
      if (header.value === null) {
        const kept = previous.find(old => old.name.toLowerCase() === name.toLowerCase())
        if (!kept || !kept.secret || !header.secret) throw new McpInputError(`请填写请求头 ${name} 的值。`)
        out.push({ name, value: kept.value, secret: true })
        continue
      }
      out.push({ name, value: header.secret ? await encryptSecret(this.secret, header.value) : header.value, secret: header.secret })
    }
    return out
  }
}

export function mcpServerView(row: McpServerRow): McpServerView {
  return {
    key: row.key,
    name: row.name,
    url: row.url,
    transport: row.transport,
    headers: row.headers.map(header => ({ name: header.name, value: header.secret ? null : header.value, secret: header.secret })),
    enabled: row.enabled,
    disabled_tools: row.disabled_tools,
    oauth: row.oauth !== null,
    status: row.status,
    last_error: row.last_error,
    updated_at: row.updated_at,
  }
}
