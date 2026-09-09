import {
  CODEX_API_BASE_URL,
  CODEX_AUTH_BASE_URL,
  CODEX_CLIENT_ID,
  CODEX_CLIENT_VERSION,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
} from './constants'
import {
  CodexProtocolError,
  type CodexProtocolDiagnostics,
  type CodexDeviceGrant,
  type CodexDevicePoll,
  type CodexIdentity,
  type CodexProtocolErrorCategory,
  type CodexTokenBundle,
} from './types'

const DEVICE_CODE_EXPIRY_MS = 15 * 60 * 1_000
const DEFAULT_POLL_INTERVAL_MS = 5_000

export interface CodexClient {
  requestDeviceCode(signal?: AbortSignal): Promise<CodexDeviceGrant>
  pollDeviceCode(deviceAuthId: string, userCode: string, signal?: AbortSignal): Promise<CodexDevicePoll>
  exchangeDeviceCode(poll: Extract<CodexDevicePoll, { status: 'authorized' }>, signal?: AbortSignal): Promise<CodexTokenBundle>
  refreshTokens(current: CodexTokenBundle, signal?: AbortSignal): Promise<CodexTokenBundle>
  revoke(refreshToken: string, signal?: AbortSignal): Promise<void>
  listModels(credentials: Pick<CodexTokenBundle, 'accessToken' | 'accountId'>, signal?: AbortSignal): Promise<string[]>
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(record: JsonRecord, key: string, operation: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') throw protocolError(operation, 'upstream', null)
  return value
}

function optionalString(record: JsonRecord, key: string, operation: string): string | undefined {
  if (!(key in record)) return undefined
  return requiredString(record, key, operation)
}

function protocolError(operation: string, category: CodexProtocolErrorCategory, status: number | null, diagnostics: CodexProtocolDiagnostics = {}): CodexProtocolError {
  return new CodexProtocolError(operation, category, status, diagnostics)
}

function responseDiagnostics(response: Response): CodexProtocolDiagnostics {
  const field = (name: string) => response.headers.get(name) || undefined
  return {
    upstreamServer: field('server'), upstreamContentType: field('content-type'), cfRay: field('cf-ray'),
    requestId: field('x-request-id'), cfMitigated: field('cf-mitigated'),
  }
}

async function parseJson(response: Response, operation: string, status: number | null = response.status): Promise<JsonRecord> {
  try {
    const body: unknown = await response.json()
    if (!isRecord(body)) throw protocolError(operation, 'upstream', status)
    return body
  } catch (error) {
    if (error instanceof CodexProtocolError) throw error
    throw protocolError(operation, 'upstream', status)
  }
}

function isPositiveFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function parsePollInterval(value: unknown, operation: string): number {
  if (value === undefined) return DEFAULT_POLL_INTERVAL_MS
  const seconds = typeof value === 'string' ? Number(value.trim()) : value
  if (!isPositiveFiniteInteger(seconds)) throw protocolError(operation, 'upstream', null)
  return seconds * 1_000
}

function parseExpiresIn(value: unknown, operation: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw protocolError(operation, 'upstream', null)
  return value * 1_000
}

function decodeBase64Url(value: string, operation: string): string {
  try {
    const base64 = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - value.length % 4) % 4)}`
    return new TextDecoder().decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0)))
  } catch {
    throw protocolError(operation, 'upstream', null)
  }
}

function parseJwtPayload(token: string, operation: string): JsonRecord {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some(part => part === '')) throw protocolError(operation, 'upstream', null)

  try {
    const decoded: unknown = JSON.parse(decodeBase64Url(parts[1]!, operation))
    if (!isRecord(decoded)) throw protocolError(operation, 'upstream', null)
    return decoded
  } catch (error) {
    if (error instanceof CodexProtocolError) throw error
    throw protocolError(operation, 'upstream', null)
  }
}

function parseAccessTokenExpiry(accessToken: string, operation: string, currentTime: number): number {
  const exp = parseJwtPayload(accessToken, operation).exp
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp < 0) throw protocolError(operation, 'upstream', null)
  const expiresAt = exp * 1_000
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= currentTime) throw protocolError(operation, 'upstream', null)
  return expiresAt
}

export function parseCodexIdentity(idToken: string): CodexIdentity {
  const operation = 'token response'
  const claims = parseJwtPayload(idToken, operation)

  const auth = claims['https://api.openai.com/auth']
  const profile = claims['https://api.openai.com/profile']
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined
  const email = typeof claims.email === 'string' ? claims.email : isRecord(profile) ? profile.email : undefined
  if (typeof accountId !== 'string' || accountId.trim() === '' || typeof email !== 'string' || email.trim() === '') {
    throw protocolError(operation, 'upstream', null)
  }
  return { accountId, email }
}

function extractRefreshErrorCode(body: JsonRecord): string | undefined {
  const error = body.error
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error.code === 'string') return error.code
  return typeof body.code === 'string' ? body.code : undefined
}

async function refreshFailure(response: Response): Promise<CodexProtocolError> {
  const body = await parseJson(response, 'token refresh', response.status).catch(() => null)
  const code = body ? extractRefreshErrorCode(body)?.toLowerCase() : undefined
  const permanent = response.status < 500 && (response.status === 401
    || (response.status === 400 && code === 'invalid_grant')
    || code === 'refresh_token_expired'
    || code === 'refresh_token_reused'
    || code === 'refresh_token_invalidated')
  return protocolError('token refresh', permanent ? 'permanent' : response.status >= 500 ? 'transient' : 'upstream', response.status, responseDiagnostics(response))
}

export function createCodexClient(fetchFn: typeof fetch = fetch, now: () => number = Date.now): CodexClient {
  async function request(operation: string, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetchFn(url, { ...init, signal })
    } catch {
      throw protocolError(operation, 'transient', null)
    }
  }

  async function requestDeviceCode(signal?: AbortSignal): Promise<CodexDeviceGrant> {
    const operation = 'device code request'
    const response = await request(operation, `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    }, signal)
    if (!response.ok) throw protocolError(operation, response.status >= 500 ? 'transient' : 'upstream', response.status, responseDiagnostics(response))
    const body = await parseJson(response, operation)
    return {
      deviceAuthId: requiredString(body, 'device_auth_id', operation),
      userCode: requiredString(body, 'user_code' in body ? 'user_code' : 'usercode', operation),
      verificationUrl: `${CODEX_AUTH_BASE_URL}/codex/device`,
      intervalMs: parsePollInterval(body.interval, operation),
      expiresAt: now() + DEVICE_CODE_EXPIRY_MS,
    }
  }

  async function pollDeviceCode(deviceAuthId: string, userCode: string, signal?: AbortSignal): Promise<CodexDevicePoll> {
    const operation = 'device code poll'
    const response = await request(operation, `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    }, signal)
    if (response.status === 403 || response.status === 404) return { status: 'pending' }
    if (!response.ok) throw protocolError(operation, response.status >= 500 ? 'transient' : 'upstream', response.status, responseDiagnostics(response))
    const body = await parseJson(response, operation)
    return {
      status: 'authorized',
      authorizationCode: requiredString(body, 'authorization_code', operation),
      codeVerifier: requiredString(body, 'code_verifier', operation),
      codeChallenge: requiredString(body, 'code_challenge', operation),
    }
  }

  async function exchangeDeviceCode(poll: Extract<CodexDevicePoll, { status: 'authorized' }>, signal?: AbortSignal): Promise<CodexTokenBundle> {
    const operation = 'token exchange'
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: poll.authorizationCode,
      redirect_uri: CODEX_DEVICE_REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: poll.codeVerifier,
    })
    const response = await request(operation, `${CODEX_AUTH_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, signal)
    if (!response.ok) throw protocolError(operation, response.status >= 500 ? 'transient' : 'upstream', response.status, responseDiagnostics(response))
    const tokens = await parseJson(response, operation)
    const idToken = requiredString(tokens, 'id_token', operation)
    const identity = parseCodexIdentity(idToken)
    return {
      idToken,
      accessToken: requiredString(tokens, 'access_token', operation),
      refreshToken: requiredString(tokens, 'refresh_token', operation),
      tokenType: requiredString(tokens, 'token_type', operation),
      ...identity,
      expiresAt: now() + parseExpiresIn(tokens.expires_in, operation),
    }
  }

  async function refreshTokens(current: CodexTokenBundle, signal?: AbortSignal): Promise<CodexTokenBundle> {
    const operation = 'token refresh'
    const body = new URLSearchParams({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      scope: 'openid profile email',
    })
    const response = await request(operation, `${CODEX_AUTH_BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, signal)
    if (!response.ok) throw await refreshFailure(response)
    const tokens = await parseJson(response, operation)
    const idToken = optionalString(tokens, 'id_token', operation) ?? current.idToken
    const identity = tokens.id_token === undefined ? { accountId: current.accountId, email: current.email } : parseCodexIdentity(idToken)
    if (identity.accountId !== current.accountId) throw protocolError(operation, 'permanent', response.status)
    const accessToken = optionalString(tokens, 'access_token', operation) ?? current.accessToken
    const expiresIn = tokens.expires_in === undefined ? undefined : parseExpiresIn(tokens.expires_in, operation)
    return {
      idToken,
      accessToken,
      refreshToken: optionalString(tokens, 'refresh_token', operation) ?? current.refreshToken,
      tokenType: optionalString(tokens, 'token_type', operation) ?? current.tokenType,
      ...identity,
      expiresAt: expiresIn === undefined ? parseAccessTokenExpiry(accessToken, operation, now()) : now() + expiresIn,
    }
  }

  async function revoke(refreshToken: string, signal?: AbortSignal): Promise<void> {
    const operation = 'token revoke'
    const response = await request(operation, `${CODEX_AUTH_BASE_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Originator: CODEX_ORIGINATOR },
      body: JSON.stringify({ token: refreshToken, token_type_hint: 'refresh_token', client_id: CODEX_CLIENT_ID }),
    }, signal)
    if (!response.ok) throw protocolError(operation, response.status >= 500 ? 'transient' : 'upstream', response.status, responseDiagnostics(response))
  }

  async function listModels(credentials: Pick<CodexTokenBundle, 'accessToken' | 'accountId'>, signal?: AbortSignal): Promise<string[]> {
    const operation = 'model listing'
    const response = await request(operation, `${CODEX_API_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credentials.accessToken}`,
        'ChatGPT-Account-ID': credentials.accountId,
        Originator: CODEX_ORIGINATOR,
        'User-Agent': CODEX_USER_AGENT,
      },
    }, signal)
    if (!response.ok) throw protocolError(operation, response.status >= 500 ? 'transient' : 'upstream', response.status, responseDiagnostics(response))
    const body = await parseJson(response, operation)
    if (!Array.isArray(body.models)) throw protocolError(operation, 'upstream', response.status)
    const slugs = body.models.map(model => {
      if (!isRecord(model) || typeof model.slug !== 'string' || model.slug.trim() === '') throw protocolError(operation, 'upstream', response.status)
      if (model.supported_in_api !== undefined && typeof model.supported_in_api !== 'boolean') throw protocolError(operation, 'upstream', response.status)
      // ChatGPT authentication can use models that are unavailable through the public API.
      return model.slug
    })
    return [...new Set(slugs)].sort()
  }

  return { requestDeviceCode, pollDeviceCode, exchangeDeviceCode, refreshTokens, revoke, listModels }
}
