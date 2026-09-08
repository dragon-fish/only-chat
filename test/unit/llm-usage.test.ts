import { describe, expect, it } from 'vitest'
import { toUsage } from '@/server/plugins/llm/usage'

describe('toUsage', () => {
  it('maps the nested AI SDK usage to the flat shape', () => {
    expect(toUsage({
      inputTokens: 10,
      inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0 },
      outputTokens: 5,
      outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
      totalTokens: 15,
    })).toEqual({ prompt: 10, completion: 5, cached: 2, reasoning: 2 })
  })

  it('keeps undefined for unreported fields and 0 for reported zeros', () => {
    const u = toUsage({
      inputTokens: 4,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokens: 0,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: 4,
    })
    expect(u).toEqual({ prompt: 4, completion: 0 })
    expect(Object.keys(u!)).toEqual(['prompt', 'completion'])
  })

  it('returns null without usage', () => {
    expect(toUsage(undefined)).toBeNull()
  })

  it('records server-observed first-token and generation durations', () => {
    expect(toUsage({
      inputTokens: 200,
      inputTokenDetails: { noCacheTokens: 150, cacheReadTokens: 50, cacheWriteTokens: undefined },
      outputTokens: 100,
      outputTokenDetails: { textTokens: 70, reasoningTokens: 30 },
      totalTokens: 300,
    }, { requestStartedAt: 1_000, firstTokenAt: 1_400, finishedAt: 5_400 })).toEqual({
      prompt: 200,
      completion: 100,
      cached: 50,
      reasoning: 30,
      time_to_first_token_ms: 400,
      generation_duration_ms: 4_000,
      total_duration_ms: 4_400,
    })
  })
})
