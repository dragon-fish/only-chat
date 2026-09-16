import type { LanguageModelUsage } from 'ai'
import type { StepUsage, Usage } from '@/shared/models'

export interface UsageTiming {
  requestStartedAt: number
  firstTokenAt: number | null
  finishedAt: number
  generationDurationMs?: number
}

export interface GenerationStepPerformance {
  outputTokens: number | undefined
  outputTokensPerSecond: number | undefined
}

/** Sum model output windows without charging tool execution or later-step TTFT to generation speed. */
export function generationDurationMs(steps: readonly GenerationStepPerformance[]): number | undefined {
  let duration = 0
  let measured = false
  for (const step of steps) {
    if (step.outputTokens === undefined) return undefined
    if (step.outputTokens === 0) continue
    if (step.outputTokensPerSecond === undefined || step.outputTokensPerSecond <= 0) return undefined
    duration += step.outputTokens / step.outputTokensPerSecond * 1000
    measured = true
  }
  return measured ? duration : undefined
}

/** One round trip's counts, kept in order so a turn's context can be told from its cost. */
export function toStepUsage(u: LanguageModelUsage | undefined): StepUsage {
  const out: StepUsage = {}
  if (!u) return out
  if (u.inputTokens !== undefined) out.prompt = u.inputTokens
  if (u.outputTokens !== undefined) out.completion = u.outputTokens
  if (u.inputTokenDetails?.cacheReadTokens !== undefined) out.cached = u.inputTokenDetails.cacheReadTokens
  if (u.outputTokenDetails?.reasoningTokens !== undefined) out.reasoning = u.outputTokenDetails.reasoningTokens
  return out
}

/** Flattens AI SDK 7's nested usage. Absent keys mean "not reported"; 0 means "reported zero". */
export function toUsage(u: LanguageModelUsage | undefined, timing?: UsageTiming, steps: readonly StepUsage[] = []): Usage | null {
  if (!u) return null
  const out: Usage = {}
  if (steps.length > 0) out.steps = [...steps]
  if (u.inputTokens !== undefined) out.prompt = u.inputTokens
  if (u.outputTokens !== undefined) out.completion = u.outputTokens
  if (u.inputTokenDetails?.cacheReadTokens !== undefined) out.cached = u.inputTokenDetails.cacheReadTokens
  if (u.outputTokenDetails?.reasoningTokens !== undefined) out.reasoning = u.outputTokenDetails.reasoningTokens
  if (timing) {
    out.total_duration_ms = Math.max(0, timing.finishedAt - timing.requestStartedAt)
    if (timing.firstTokenAt !== null) {
      out.time_to_first_token_ms = Math.max(0, timing.firstTokenAt - timing.requestStartedAt)
    }
    if (timing.generationDurationMs !== undefined) out.generation_duration_ms = Math.max(0, timing.generationDurationMs)
  }
  return out
}
