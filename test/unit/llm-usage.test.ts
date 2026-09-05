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
})
