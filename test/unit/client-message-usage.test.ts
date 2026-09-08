import { expect, it } from 'vitest'
import { messageContextUsage, messageUsageMetrics } from '@/client/lib/ui-models'

it('derives cache share and total-output throughput from persisted usage', () => {
  expect(messageUsageMetrics({ prompt: 200, completion: 100, cached: 50, generation_duration_ms: 4_000 })).toEqual({
    cachedPercent: 25,
    tokensPerSecond: 25,
  })
})

it('does not invent rates when their denominator is absent or zero', () => {
  expect(messageUsageMetrics({ prompt: 0, completion: 12, generation_duration_ms: 0 })).toEqual({
    cachedPercent: null,
    tokensPerSecond: null,
  })
})

it('treats the completed turn as part of the next context', () => {
  expect(messageContextUsage({ prompt: 200_000, completion: 50_000 }, 1_000_000)).toEqual({
    used: 250_000,
    limit: 1_000_000,
    percent: 25,
  })
  expect(messageContextUsage({ prompt: 200_000 }, 1_000_000)).toBeNull()
})
