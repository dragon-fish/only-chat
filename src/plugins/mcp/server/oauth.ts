import type {
  OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthClientMetadata, OAuthClientProvider, OAuthTokens,
} from '@ai-sdk/mcp'
import type { McpServerRow } from '@/server/db/schema'
import type { McpServerStore } from './store'

/** What the SDK asks us to keep for one server, stored as one ciphertext in `mcp_servers.oauth`. */
export interface StoredMcpOAuth {
  redirectUrl?: string
  clientInformation?: OAuthClientInformation
  dynamicallyRegistered?: boolean
  authorizationServer?: OAuthAuthorizationServerInformation
  tokens?: OAuthTokens
}

/** One pending authorization, keyed by its `state` in KV. */
export interface PendingMcpAuthorization {
  userId: number
  key: string
  codeVerifier: string
}

export const OAUTH_STATE_TTL_SECONDS = 600
export const oauthStateKey = (state: string) => `mcp-oauth:${state}`

/**
 * The server wants a person to sign in. Raised wherever the SDK would otherwise start that on its
 * own — registering a client, or sending someone to the authorization page — because neither a
 * generation nor a connection test has anyone to send.
 */
export class McpNeedsAuthorization extends Error {
  constructor() {
    super('该服务需要用户在设置的「MCP」里完成授权。')
  }
}

/**
 * - `background`: a generation or a connection test. Uses and refreshes what is stored; never
 *   registers a client or starts an authorization.
 * - `authorize`: the person pressed 「授权」. May register a client; captures the authorization URL.
 * - `callback`: the authorization server sent the person back with a code to exchange.
 */
export type McpOAuthMode =
  | { kind: 'background' }
  | { kind: 'authorize', redirectUrl: string, kv: KVNamespace, userId: number }
  | { kind: 'callback', codeVerifier: string, state: string }

export class McpOAuthProvider implements OAuthClientProvider {
  /** Set by `redirectToAuthorization` in `authorize` mode. */
  authorizationUrl: URL | null = null
  private stored: StoredMcpOAuth | null = null
  private loaded = false
  private pendingState: string | undefined

  constructor(
    private readonly store: McpServerStore,
    private readonly row: McpServerRow,
    private readonly mode: McpOAuthMode,
  ) {}

  private async read(): Promise<StoredMcpOAuth> {
    if (!this.loaded) {
      this.stored = await this.store.readOAuth<StoredMcpOAuth>(this.row)
      this.loaded = true
    }
    return this.stored ?? {}
  }

  private async write(patch: Partial<StoredMcpOAuth>): Promise<void> {
    const next = { ...(await this.read()), ...patch }
    this.stored = next
    await this.store.writeOAuth(this.row, next)
  }

  get redirectUrl(): string {
    // Background refreshes never use it; registration and authorization happen in `authorize`.
    if (this.mode.kind === 'authorize') return this.mode.redirectUrl
    return this.stored?.redirectUrl ?? ''
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Only Chat',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write({ tokens })
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const info = (await this.read()).clientInformation
    // Returning nothing here is what makes the SDK register a client, which only a person's
    // authorization may do: a background registration would leave an unusable client behind.
    if (!info && this.mode.kind === 'background') throw new McpNeedsAuthorization()
    return info
  }

  async saveClientInformation(clientInformation: OAuthClientInformation): Promise<void> {
    if (this.mode.kind !== 'authorize') throw new McpNeedsAuthorization()
    await this.write({ clientInformation, dynamicallyRegistered: true, redirectUrl: this.mode.redirectUrl })
  }

  async isClientInformationDynamicallyRegistered(): Promise<boolean> {
    return (await this.read()).dynamicallyRegistered === true
  }

  async authorizationServerInformation(): Promise<OAuthAuthorizationServerInformation | undefined> {
    return (await this.read()).authorizationServer
  }

  async saveAuthorizationServerInformation(authorizationServer: OAuthAuthorizationServerInformation): Promise<void> {
    await this.write({ authorizationServer })
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    if (scope === 'verifier') return
    const current = await this.read()
    if (scope === 'tokens') await this.write({ ...current, tokens: undefined })
    else if (scope === 'client') await this.write({ ...current, clientInformation: undefined, dynamicallyRegistered: undefined })
    else await this.write({ redirectUrl: current.redirectUrl })
  }

  state(): string {
    this.pendingState = crypto.randomUUID().replaceAll('-', '')
    return this.pendingState
  }

  storedState(): string | undefined {
    return this.mode.kind === 'callback' ? this.mode.state : undefined
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (this.mode.kind !== 'authorize') throw new McpNeedsAuthorization()
    if (!this.pendingState) throw new Error('authorization started without a state')
    const pending: PendingMcpAuthorization = { userId: this.mode.userId, key: this.row.key, codeVerifier }
    await this.mode.kv.put(oauthStateKey(this.pendingState), JSON.stringify(pending), { expirationTtl: OAUTH_STATE_TTL_SECONDS })
  }

  codeVerifier(): string {
    if (this.mode.kind !== 'callback') throw new McpNeedsAuthorization()
    return this.mode.codeVerifier
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.mode.kind !== 'authorize') throw new McpNeedsAuthorization()
    this.authorizationUrl = authorizationUrl
  }
}
