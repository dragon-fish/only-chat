import { expect, it } from 'vitest'
import { summarizeProviderRequest } from '@/server/plugins/llm/observability'

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
