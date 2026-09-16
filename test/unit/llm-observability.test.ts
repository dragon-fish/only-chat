import { describe, expect, it, vi } from 'vitest'
import { observedProviderFetch, summarizeProviderRequest } from '@/server/plugins/llm/observability'

it('fingerprints serialized request items without exposing their content', async () => {
  const first = await summarizeProviderRequest(JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'top secret prompt' }],
    stream: true,
  }), 'private-test-key')
  const repeated = await summarizeProviderRequest(JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'top secret prompt' }],
    stream: true,
  }), 'private-test-key')
  const changed = await summarizeProviderRequest(JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'different prompt' }],
    stream: true,
  }), 'private-test-key')

  expect(first).toEqual(repeated)
  expect(first).not.toEqual(changed)
  expect(JSON.stringify(first)).not.toContain('top secret prompt')
})

describe('provider request logging', () => {
  it('emits objects with a readable message, not pre-encoded strings', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const fetch = observedProviderFetch(
      { conversationId: 38, messageId: 300, providerId: 1, interfaceId: 2, protocol: 'chat-completions', modelId: 'deepseek-flash' },
      'test-key',
      async () => new Response('{}', { status: 200 }),
    )
    await fetch('https://provider.invalid/v1/chat/completions', { body: JSON.stringify({ model: 'deepseek-flash', messages: [] }) })

    const entries = info.mock.calls.map(call => call[0]) as Array<Record<string, unknown>>
    info.mockRestore()
    expect(entries.map(entry => entry.event)).toEqual(['llm.provider.request', 'llm.provider.response'])
    for (const entry of entries) {
      expect(typeof entry).toBe('object')
      expect(entry.message).toContain('conversation_id=38')
      expect(entry.conversationId).toBe(38)
    }
  })
})
