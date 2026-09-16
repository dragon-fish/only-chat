import { describe, expect, it } from 'vitest'
import { latestAssistantContextUsage, messageContextUsage, messageUsageMetrics } from '@/client/lib/ui-models'
import type { Message } from '@/shared/models'

function message(id: number, role: Message['role'], over: Partial<Message> = {}): Message {
  return {
    id, conversation_id: 1, parent_id: null, seq: id, role, parts: [], provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: id, ...over,
  }
}

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

it('keeps the last known context usage while the next assistant message is streaming', () => {
  const usage = { prompt: 200, completion: 50 }
  const path = [
    message(1, 'assistant', { provider_id: 7, model_id: 'm', usage }),
    message(2, 'user'),
    message(3, 'assistant', { provider_id: 7, model_id: 'm', status: 'streaming' }),
  ]
  expect(latestAssistantContextUsage(path, { provider_id: 7, model_id: 'm' })).toBe(usage)
})

it('does not reuse context usage across a model change', () => {
  const path = [
    message(1, 'assistant', { provider_id: 7, model_id: 'old', usage: { prompt: 200, completion: 50 } }),
    message(2, 'assistant', { provider_id: 8, model_id: 'new', status: 'streaming' }),
  ]
  expect(latestAssistantContextUsage(path, { provider_id: 8, model_id: 'new' })).toBeNull()
})

describe('context usage across a multi-step turn', () => {
  it('measures the context by the last round trip, not the turn total', () => {
    // The totals are what the turn was billed: every step resent the whole conversation, so they
    // add up to several times the context. Reading them as context pins the gauge at hundreds of
    // percent and tells the operator their conversation is full when it is not.
    const usage = {
      prompt: 1072438, completion: 68112, cached: 1047552,
      steps: [
        { prompt: 97800, completion: 24000, cached: 95000 },
        { prompt: 104000, completion: 30000, cached: 103000 },
        { prompt: 105400, completion: 4112, cached: 104000 },
      ],
    }
    expect(messageContextUsage(usage, 128000)).toMatchObject({ used: 109512, limit: 128000 })
    expect(messageContextUsage(usage, 128000)!.percent).toBeCloseTo(85.6, 1)
  })

  it('falls back to the totals for a turn recorded before steps were kept', () => {
    expect(messageContextUsage({ prompt: 1000, completion: 200 }, 10000)).toMatchObject({ used: 1200 })
  })
})
