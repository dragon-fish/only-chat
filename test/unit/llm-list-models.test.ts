import { describe, expect, it } from 'vitest'
import { listRemoteModels } from '@/server/plugins/llm/list-models'
import type { ProviderInterface } from '@/shared/models'

const base: ProviderInterface = {
  id: 1, provider_id: 1, protocol: 'chat-completions', base_url: 'https://api.example.com/v1', native_files: false, created_at: 0,
}

describe('listRemoteModels', () => {
  it('calls {base_url}/models with a bearer token for openai protocols', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const ids = await listRemoteModels(base, 'sk', fetchFn)
    expect(ids).toEqual(['a', 'b'])
    expect(calls[0]![0]).toBe('https://api.example.com/v1/models')
    expect((calls[0]![1]!.headers as Record<string, string>).Authorization).toBe('Bearer sk')
  })

  it('uses x-api-key and anthropic-version for anthropic', async () => {
    let headers: Record<string, string> = {}
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers = init!.headers as Record<string, string>
      return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const ids = await listRemoteModels({ ...base, protocol: 'anthropic' }, 'sk', fetchFn)
    expect(ids).toEqual(['claude-x'])
    expect(headers['x-api-key']).toBe('sk')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('throws on non-2xx', async () => {
    const fetchFn = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(listRemoteModels(base, 'sk', fetchFn)).rejects.toThrow(/401/)
  })

  // A Vertex-shaped Base URL has no `/models` listing: the gateway's catalogue lives under its
  // separate OpenAI-compatible base, which we must not guess at.
  it('refuses vertex-compatible without probing the base URL', async () => {
    const fetchFn = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch
    await expect(listRemoteModels({ ...base, protocol: 'vertex-compatible' }, 'sk', fetchFn)).rejects.toThrow(/not supported/)
  })
})
