import type { LanguageModelUsage } from 'ai'
import type { Usage } from '@/shared/models'

/** Flattens AI SDK 7's nested usage. Absent keys mean "not reported"; 0 means "reported zero". */
export function toUsage(u: LanguageModelUsage | undefined): Usage | null {
  if (!u) return null
  const out: Usage = {}
  if (u.inputTokens !== undefined) out.prompt = u.inputTokens
  if (u.outputTokens !== undefined) out.completion = u.outputTokens
  if (u.inputTokenDetails?.cacheReadTokens !== undefined) out.cached = u.inputTokenDetails.cacheReadTokens
  if (u.outputTokenDetails?.reasoningTokens !== undefined) out.reasoning = u.outputTokenDetails.reasoningTokens
  return out
}
