import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { Codex } from '@/server/plugins/codex'
import type { CodexCredentialSnapshot } from '@/server/plugins/codex/credentials'
import type { ModelRow, ProviderInterfaceRow, ProviderRow } from '@/server/db/schema'
import { createCodexModel, normalizeCodexResponsesBody } from '@/server/plugins/llm/providers/codex'

const snapshot = (accessToken = 'private-access'): CodexCredentialSnapshot => ({
  providerId: 1, revision: 1, credentialVersion: 1, accountId: 'private-account', status: 'connected', encryptedBundle: 'encrypted',
  bundle: { accessToken, refreshToken: 'private-refresh', idToken: 'private-id', accountId: 'private-account', email: 'owner@example.com', tokenType: 'Bearer', expiresAt: Date.now() + 3_600_000 },
})
const provider = { id: 1, kind: 'codex-oauth', api_key: null } as ProviderRow
const endpoint = { id: 1, provider_id: 1, protocol: 'responses', base_url: 'https://untrusted.example', native_files: false } as ProviderInterfaceRow
const model = { id: 1, provider_id: 1, model_id: 'gpt-test' } as ModelRow
const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'private-prompt' }] }]
const trace = { sessionId: 1, messageId: 2, providerId: 1, interfaceId: 1, protocol: 'responses' as const, modelId: 'gpt-test' }
const emptyStream = () => new Response('', { headers: { 'content-type': 'text/event-stream' } })
function service() {
  const getValidCredentials = vi.fn(async (_id: number, force?: boolean) => snapshot(force ? 'private-rotated' : 'private-access'))
  return { codex: { getValidCredentials } as unknown as Codex, getValidCredentials }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Codex Responses transport', () => {
  it('forces stateless requests and removes unsupported fields while preserving local history', () => {
    const input = [{ type: 'reasoning', id: 'rs_local', encrypted_content: 'private-reasoning' }]
    const normalized = JSON.parse(normalizeCodexResponsesBody(JSON.stringify({
      model: 'gpt-test', input, store: true, previous_response_id: 'remote', conversation: 'remote',
      generate: true, prompt_cache_retention: '24h', safety_identifier: 'private-user', stream_options: {},
      include: ['message.output_text.logprobs', 'reasoning.encrypted_content'],
    })))
    expect(normalized).toEqual({ model: 'gpt-test', input, instructions: '', store: false, include: ['message.output_text.logprobs', 'reasoning.encrypted_content'] })
    const withInstructions = normalizeCodexResponsesBody('{"model":"gpt-test","input":[],"instructions":"system"}')
    expect(JSON.parse(withInstructions)).toEqual({
      model: 'gpt-test', input: [], instructions: 'system', store: false, include: ['reasoning.encrypted_content'],
    })
  })

  it.each(['private-invalid-json', 'null', '[]'])('rejects malformed bodies without exposing their contents (%s)', body => {
    expect(() => normalizeCodexResponsesBody(body)).toThrow('Codex Responses request body must be a JSON object')
  })

  it('uses the fixed endpoint and credential headers in the actual SDK request', async () => {
    const { codex } = service()
    let request!: Request
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => { request = new Request(input, init); return emptyStream() })
    const lm = await createCodexModel(codex, provider, endpoint, model) as LanguageModelV4
    const result = await lm.doStream({ prompt, headers: { Authorization: 'forged', 'ChatGPT-Account-ID': 'forged', Originator: 'forged' } })
    await result.stream.cancel()
    expect(lm.provider).toBe('responses.responses')
    expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(Object.fromEntries(request.headers)).toMatchObject({ authorization: 'Bearer private-access', 'chatgpt-account-id': 'private-account', originator: 'codex_cli_rs' })
    expect(await request.json()).toMatchObject({ model: 'gpt-test', input: [{ content: [{ text: 'private-prompt' }] }], store: false, instructions: '', include: ['reasoning.encrypted_content'] })
  })

  it.each([200, 401])('refreshes exactly once after a pre-stream 401 (retry status %s)', async retryStatus => {
    const { codex, getValidCredentials } = service()
    const requests: Request[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return requests.length === 1 || retryStatus === 401
        ? Response.json({ error: { message: 'private-upstream-body' } }, { status: 401 }) : emptyStream()
    })
    const lm = await createCodexModel(codex, provider, endpoint, model) as LanguageModelV4
    if (retryStatus === 200) await (await lm.doStream({ prompt })).stream.cancel()
    else await expect(lm.doStream({ prompt })).rejects.toThrow(/Codex.*401/)
    expect(requests.map(req => req.headers.get('authorization'))).toEqual(['Bearer private-access', 'Bearer private-rotated'])
    expect(getValidCredentials.mock.calls.filter(([, force]) => force)).toEqual([[1, true]])
    expect(await requests[0]!.text()).toBe(await requests[1]!.text())
  })

  it('returns a live stream without buffering or replaying its body', async () => {
    const { codex, getValidCredentials } = service()
    let bodyController!: ReadableStreamDefaultController<Uint8Array>
    const remote = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { bodyController = c } }), { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', remote)
    const lm = await createCodexModel(codex, provider, endpoint, model) as LanguageModelV4
    const reader = (await lm.doStream({ prompt })).stream.getReader()
    expect((await reader.read()).value).toMatchObject({ type: 'stream-start' })
    bodyController.close()
    await reader.cancel()
    expect(remote).toHaveBeenCalledTimes(1)
    expect(getValidCredentials.mock.calls.some(([, force]) => force)).toBe(false)
  })

  it('never refreshes or replays an authentication failure delivered inside an accepted SSE stream', async () => {
    const { codex, getValidCredentials } = service()
    const remote = vi.fn(async () => new Response('data: {"type":"error","error":{"code":"401","message":"authentication expired"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', remote)
    const lm = await createCodexModel(codex, provider, endpoint, model) as LanguageModelV4
    const chunks = []
    for await (const chunk of (await lm.doStream({ prompt })).stream) chunks.push(chunk)
    expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error' })]))
    expect(remote).toHaveBeenCalledTimes(1)
    expect(getValidCredentials.mock.calls.some(([, force]) => force)).toBe(false)
  })

  it.each(['success', 'http', 'network'] as const)('redacts transport observability and surfaced errors (%s)', async mode => {
    const { codex } = service()
    const logs: unknown[][] = []
    for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args) })
    vi.stubGlobal('fetch', async () => {
      if (mode === 'network') throw new Error('private-access private-refresh private-upstream-body')
      return mode === 'http' ? Response.json({ error: { message: 'private-upstream-body' } }, { status: 403 }) : emptyStream()
    })
    const lm = await createCodexModel(codex, provider, endpoint, model, trace) as LanguageModelV4
    let error: unknown
    try { await (await lm.doStream({ prompt })).stream.cancel() } catch (caught) { error = caught }
    expect(logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toMatch(/private-(access|refresh|id|account|prompt|upstream|reasoning)/)
    if (mode !== 'success') {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toMatch(/private-/)
      expect(JSON.stringify(error)).not.toMatch(/private-/)
    }
  })
})
