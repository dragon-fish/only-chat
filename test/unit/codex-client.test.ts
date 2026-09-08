import { describe, expect, it } from 'vitest'
import { createCodexClient } from '@/server/plugins/codex/client'
import { CodexProtocolError, type CodexTokenBundle } from '@/server/plugins/codex/types'

interface RecordedRequest {
  url: string
  method: string
  headers: Headers
  body: string | null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recordingFetch(responses: Array<Response | Error>) {
  const requests: RecordedRequest[] = []
  const fetchStub: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.text(),
    })
    const response = responses.shift()
    if (response instanceof Error) throw response
    if (!response) throw new Error('Unexpected request')
    return response
  }
  return { fetchStub, requests }
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`
}

function idToken(claims: Record<string, unknown> = {}): string {
  return jwt({
    email: 'me@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
    ...claims,
  })
}

const currentTokens: CodexTokenBundle = {
  idToken: idToken(),
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  tokenType: 'Bearer',
  accountId: 'account-1',
  email: 'me@example.com',
  expiresAt: 1_000,
}

describe('Codex OAuth client', () => {
  it('requests a device code with the fixed endpoint and numeric polling interval', async () => {
    const { fetchStub, requests } = recordingFetch([json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 5 })])
    const client = createCodexClient(fetchStub, () => 0)

    await expect(client.requestDeviceCode()).resolves.toEqual({
      deviceAuthId: 'device-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
      intervalMs: 5_000,
      expiresAt: 900_000,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
      method: 'POST',
      body: JSON.stringify({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
    })
    expect(requests[0]?.headers.get('content-type')).toBe('application/json')
  })

  it('accepts a string device polling interval', async () => {
    const { fetchStub } = recordingFetch([json({ device_auth_id: 'device-1', usercode: 'ABCD-EFGH', interval: '7' })])

    await expect(createCodexClient(fetchStub, () => 4).requestDeviceCode()).resolves.toMatchObject({
      intervalMs: 7_000,
      expiresAt: 900_004,
    })
  })

  it.each([403, 404])('returns pending when device polling receives %i', async status => {
    const { fetchStub, requests } = recordingFetch([json({ error: 'authorization_pending' }, status)])

    await expect(createCodexClient(fetchStub).pollDeviceCode('device-1', 'ABCD-EFGH')).resolves.toEqual({ status: 'pending' })
    expect(requests[0]).toMatchObject({
      url: 'https://auth.openai.com/api/accounts/deviceauth/token',
      method: 'POST',
      body: JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH' }),
    })
  })

  it('returns authorized device polling data', async () => {
    const { fetchStub } = recordingFetch([json({
      authorization_code: 'authorization-code',
      code_verifier: 'verifier',
      code_challenge: 'challenge',
    })])

    await expect(createCodexClient(fetchStub).pollDeviceCode('device-1', 'ABCD-EFGH')).resolves.toEqual({
      status: 'authorized', authorizationCode: 'authorization-code', codeVerifier: 'verifier', codeChallenge: 'challenge',
    })
  })

  it('exchanges an authorized device code and derives the account identity', async () => {
    const { fetchStub, requests } = recordingFetch([json({
      id_token: idToken(), access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600,
    })])
    const client = createCodexClient(fetchStub, () => 100)

    await expect(client.exchangeDeviceCode({
      status: 'authorized', authorizationCode: 'authorization-code', codeVerifier: 'verifier', codeChallenge: 'challenge',
    })).resolves.toEqual({
      idToken: idToken(), accessToken: 'access-1', refreshToken: 'refresh-1', tokenType: 'Bearer',
      accountId: 'account-1', email: 'me@example.com', expiresAt: 3_600_100,
    })
    expect(requests[0]).toMatchObject({ url: 'https://auth.openai.com/oauth/token', method: 'POST' })
    expect(new URLSearchParams(requests[0]?.body ?? '')).toEqual(new URLSearchParams({
      grant_type: 'authorization_code', code: 'authorization-code', redirect_uri: 'https://auth.openai.com/deviceauth/callback',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code_verifier: 'verifier',
    }))
    expect(requests[0]?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  })

  it('rotates refresh tokens and retains omitted token fields', async () => {
    const { fetchStub, requests } = recordingFetch([json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })])
    const client = createCodexClient(fetchStub, () => 100)

    await expect(client.refreshTokens(currentTokens)).resolves.toEqual({
      ...currentTokens, accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 3_600_100,
    })
    expect(requests[0]).toMatchObject({ url: 'https://auth.openai.com/oauth/token', method: 'POST' })
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: 'old-refresh',
    })
    expect(requests[0]?.headers.get('originator')).toBe('codex_cli_rs')
  })

  it('accepts a replacement ID token for the bound account', async () => {
    const replacement = idToken({ email: 'updated@example.com' })
    const { fetchStub } = recordingFetch([json({ id_token: replacement, access_token: 'new-access', expires_in: 3600 })])

    await expect(createCodexClient(fetchStub, () => 100).refreshTokens(currentTokens)).resolves.toMatchObject({
      idToken: replacement, accountId: 'account-1', email: 'updated@example.com', expiresAt: 3_600_100,
    })
  })

  it('rejects a replacement ID token for a different account', async () => {
    const otherAccount = idToken({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-2' } })
    const { fetchStub } = recordingFetch([json({ id_token: otherAccount, access_token: 'new-access', expires_in: 3600 })])

    await expect(createCodexClient(fetchStub).refreshTokens(currentTokens)).rejects.toMatchObject({
      name: 'CodexProtocolError', operation: 'token refresh', category: 'permanent', status: 200,
    })
    await expect(createCodexClient(recordingFetch([json({ id_token: otherAccount, access_token: 'new-access', expires_in: 3600 })]).fetchStub)
      .refreshTokens(currentTokens)).rejects.not.toThrow('account-2')
  })

  it('derives a fresh expiry from the refreshed access token when expires_in is omitted', async () => {
    const { fetchStub } = recordingFetch([json({ access_token: jwt({ exp: 3600 }) })])

    await expect(createCodexClient(fetchStub, () => 100).refreshTokens(currentTokens)).resolves.toMatchObject({
      accessToken: jwt({ exp: 3600 }), expiresAt: 3_600_000,
    })
  })

  it('rejects an expired access token when refresh omits expires_in', async () => {
    const { fetchStub } = recordingFetch([json({ access_token: jwt({ exp: 0 }) })])

    await expect(createCodexClient(fetchStub, () => 100).refreshTokens(currentTokens)).rejects.toMatchObject({
      name: 'CodexProtocolError', operation: 'token refresh', category: 'upstream',
    })
  })

  it.each([{}, { exp: '3600' }])('rejects a missing or malformed access-token exp when refresh omits expires_in', async claims => {
    const { fetchStub } = recordingFetch([json({ access_token: jwt(claims) })])

    await expect(createCodexClient(fetchStub, () => 100).refreshTokens(currentTokens)).rejects.toMatchObject({
      name: 'CodexProtocolError', operation: 'token refresh', category: 'upstream',
    })
  })

  it('classifies known refresh credential failures as permanent without exposing upstream bodies', async () => {
    const { fetchStub } = recordingFetch([json({ error: { code: 'refresh_token_reused', message: 'old-refresh should never surface' } }, 400)])

    await expect(createCodexClient(fetchStub).refreshTokens(currentTokens)).rejects.toMatchObject({
      name: 'CodexProtocolError', category: 'permanent', status: 400,
    })
    await expect(createCodexClient(recordingFetch([json({ error: { code: 'refresh_token_reused', message: 'old-refresh should never surface' } }, 400)]).fetchStub)
      .refreshTokens(currentTokens)).rejects.not.toThrow('old-refresh')
  })

  it('classifies refresh network and server errors as transient', async () => {
    await expect(createCodexClient(recordingFetch([new Error('network failed')]).fetchStub).refreshTokens(currentTokens))
      .rejects.toMatchObject({ category: 'transient', status: null })
    await expect(createCodexClient(recordingFetch([json({ error: { code: 'refresh_token_reused' } }, 503)]).fetchStub).refreshTokens(currentTokens))
      .rejects.toMatchObject({ category: 'transient', status: 503 })
  })

  it('revokes a refresh token through the fixed OAuth endpoint', async () => {
    const { fetchStub, requests } = recordingFetch([new Response(null, { status: 204 })])

    await expect(createCodexClient(fetchStub).revoke('refresh-1')).resolves.toBeUndefined()
    expect(requests[0]).toMatchObject({ url: 'https://auth.openai.com/oauth/revoke', method: 'POST' })
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      token: 'refresh-1', token_type_hint: 'refresh_token', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    })
    expect(requests[0]?.headers.get('originator')).toBe('codex_cli_rs')
  })

  it('lists unique supported model slugs with fixed credentials headers', async () => {
    const { fetchStub, requests } = recordingFetch([json({ models: [
      { slug: 'zeta', supported_in_api: true }, { slug: 'alpha' }, { slug: 'zeta' }, { slug: 'disabled', supported_in_api: false },
    ] })])

    await expect(createCodexClient(fetchStub).listModels({ accessToken: 'access-1', accountId: 'account-1' })).resolves.toEqual(['alpha', 'zeta'])
    expect(requests[0]).toMatchObject({ url: 'https://chatgpt.com/backend-api/codex/models', method: 'GET' })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer access-1')
    expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('account-1')
    expect(requests[0]?.headers.get('originator')).toBe('codex_cli_rs')
  })

  it('returns sanitized protocol errors for malformed responses', async () => {
    const { fetchStub } = recordingFetch([json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 'not an interval' })])

    await expect(createCodexClient(fetchStub).requestDeviceCode()).rejects.toBeInstanceOf(CodexProtocolError)
    await expect(createCodexClient(recordingFetch([json({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: 'not an interval' })]).fetchStub)
      .requestDeviceCode()).rejects.not.toThrow('not an interval')
  })
})
