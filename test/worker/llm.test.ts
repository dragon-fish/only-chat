import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/server/app'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import type { ModelRow, ProviderRow } from '@/server/db/schema'
import type { LanguageModel } from 'ai'

/** `LanguageModel` also admits a bare gateway model id; our factories never return one. */
function built(m: LanguageModel): Exclude<LanguageModel, string> {
  if (typeof m === 'string') throw new Error(`expected a model object, got the model id ${m}`)
  return m
}

const model: ModelRow = { id: 1, provider_id: 1, model_id: 'test-model', display_name: 'x', capabilities: {}, pricing: null, enabled: true, sort: 0 }

async function provider(protocol: ProviderRow['protocol'], key: string | null, extra: Record<string, unknown> | null = null): Promise<ProviderRow> {
  return {
    id: 1, user_id: 1, name: 'p', protocol, base_url: 'https://example.com/v1',
    api_key: key ? await encryptSecret(env.KEY_ENCRYPTION_SECRET, key) : null, extra, enabled: true, created_at: 0,
  }
}

describe('Llm service', () => {
  it('registers the four protocols and builds models without network', async () => {
    const ctx = await createApp({ env, side: 'hub' })
    for (const p of ['openai-completions', 'openai-responses', 'anthropic', 'vertex'] as const) expect(ctx.llm.has(p)).toBe(true)

    const compat = built(await ctx.llm.createModel(await provider('openai-completions', 'k'), model))
    expect(compat.provider).toBe('compat.chat')
    expect(compat.modelId).toBe('test-model')

    const responses = built(await ctx.llm.createModel(await provider('openai-responses', 'k'), model))
    expect(responses.provider).toBe('openai.responses')

    const anthropic = built(await ctx.llm.createModel(await provider('anthropic', 'k'), model))
    expect(anthropic.provider).toBe('anthropic.messages')

    const sa = JSON.stringify({ client_email: 'a@b', private_key: 'PEM', private_key_id: 'kid' })
    const vertex = built(await ctx.llm.createModel(await provider('vertex', sa, { project: 'proj', location: 'us-central1' }), model))
    expect(vertex.provider).toBe('google.vertex.chat')
  })

  it('rejects a missing key', async () => {
    const ctx = await createApp({ env, side: 'hub' })
    await expect(ctx.llm.createModel(await provider('anthropic', null), model)).rejects.toThrow(/api key/i)
  })

  it('lets a test register a custom protocol and disposes it with the caller', async () => {
    const ctx = await createApp({ env, side: 'hub' })
    const fiber = await ctx.plugin({ name: 'mock-protocol', inject: ['llm'], apply(c) { c.llm.register('mock', () => ({ provider: 'mock' }) as never) } })
    expect(ctx.llm.has('mock')).toBe(true)
    await fiber.dispose()
    expect(ctx.llm.has('mock')).toBe(false)
  })
})
