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
    expect(ids.map(model => model.id)).toEqual(['a', 'b'])
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
    expect(ids.map(model => model.id)).toEqual(['claude-x'])
    expect(headers['x-api-key']).toBe('sk')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('throws on non-2xx', async () => {
    const fetchFn = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(listRemoteModels(base, 'sk', fetchFn)).rejects.toThrow(/401/)
  })

  it('normalizes Volcengine and ZenMux image capability extensions while retaining raw metadata', async () => {
    const fetchFn = (async () => Response.json({ data: [
      {
        id: 'doubao-seedream', name: 'Seedream', domain: 'ImageGeneration',
        modalities: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
        task_type: ['TextToImage', 'ImageToImage'],
      },
      {
        id: 'openai/gpt-image', display_name: 'OpenAI: GPT Image', owned_by: 'openai',
        input_modalities: ['text', 'image'], output_modalities: ['image'], capabilities: { reasoning: false },
      },
    ] })) as unknown as typeof fetch
    const models = await listRemoteModels(base, 'sk', fetchFn)
    expect(models).toEqual([
      expect.objectContaining({ id: 'doubao-seedream', metadata: expect.objectContaining({ name: 'Seedream', modalities: { input: ['text', 'image'], output: ['image'] } }) }),
      expect.objectContaining({ id: 'openai/gpt-image', metadata: expect.objectContaining({ name: 'OpenAI: GPT Image', modalities: { input: ['text', 'image'], output: ['image'] } }) }),
    ])
    expect(models[0]!.providerMetadata).toMatchObject({ domain: 'ImageGeneration', task_type: ['TextToImage', 'ImageToImage'] })
    expect(models[1]!.providerMetadata).toMatchObject({ owned_by: 'openai', capabilities: { reasoning: false } })
  })

  // A Vertex-shaped Base URL has no `/models` listing: the gateway's catalogue lives under its
  // separate OpenAI-compatible base, which we must not guess at.
  it('refuses vertex-compatible without probing the base URL', async () => {
    const fetchFn = (async () => { throw new Error('must not be called') }) as unknown as typeof fetch
    await expect(listRemoteModels({ ...base, protocol: 'vertex-compatible' }, 'sk', fetchFn)).rejects.toThrow(/not supported/)
  })
})
