import { generateText, stepCountIs, type ModelMessage } from 'ai'
import type { StepUsage, UserSettings } from '@/shared/models'
import { canServeAsServiceModel } from '@/shared/service-model'
import type { DB } from '@/server/db/client'
import type { Llm } from '@/server/plugins/llm'
import { buildProviderOptions } from '@/server/plugins/llm/messages'
import { toStepUsage } from '@/server/plugins/llm/usage'
import { resolveServiceModel } from '@/server/plugins/hub/service-model'
import type { ComposeRequest } from '@/server/plugins/context-manager'
import { summaryInstruction } from './instruction'
import { textTokens } from './estimate'
import { DEFAULT_FLATTEN_CONTEXT } from './render'

/** No summary needs more; a longer one would defeat the point (spec §3.4). */
export const MAX_SUMMARY_TOKENS = 16_000

export const NO_FALLBACK_ERROR = '上下文过长，无法在当前模型上压缩；可在设置中配置压缩备用模型'

export type SummaryOutcome =
  | { ok: true, summary: string, steps: StepUsage[] }
  | { ok: false, error: string }

interface Answer {
  text: string
  finishReason: string
  toolCalls: number
  usage: StepUsage
}

function failure(error: unknown, signal: AbortSignal): SummaryOutcome {
  if (signal.aborted) return { ok: false, error: String(signal.reason ?? 'aborted') }
  return { ok: false, error: `摘要请求失败：${error instanceof Error ? error.message : String(error)}` }
}

/** What every mode refuses: a cut-off summary, or none at all. */
function judged(answer: Answer, steps: StepUsage[]): SummaryOutcome {
  if (answer.finishReason === 'length') return { ok: false, error: '摘要输出被截断' }
  const summary = answer.text.trim()
  if (!summary) return { ok: false, error: '摘要为空' }
  return { ok: true, summary, steps }
}

export interface CachedSummaryInput {
  request: ComposeRequest
  signal: AbortSignal
  maxOutputTokens: number
  date: string
  focus: string | null
}

/**
 * The summary from the conversation's own model, as one more turn of the very request it was about
 * to send (spec §3.4): same messages, same tool definitions, the instruction appended — so the prefix
 * is read from cache. Tools stay offered with `toolChoice: 'auto'` because dropping them, as
 * `@ai-sdk/anthropic` does for `'none'`, changes the prefix. They carry no `execute`, so a call is
 * never run; a reply that makes one is asked again, once, more firmly.
 */
export async function summarizeCached({ request, signal, maxOutputTokens, date, focus }: CachedSummaryInput): Promise<SummaryOutcome> {
  const steps: StepUsage[] = []
  const ask = async (strict: boolean): Promise<Answer> => {
    const instruction: ModelMessage = { role: 'user', content: summaryInstruction({ date, focus, strict }) }
    const result = await generateText({
      model: request.languageModel,
      messages: [...request.messages, instruction],
      // The system prompt travels as a message so cache breakpoints can attach to it, as in generation.
      allowSystemInMessages: true,
      tools: request.tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(1),
      providerOptions: request.providerOptions,
      maxOutputTokens,
      abortSignal: signal,
    })
    const usage = toStepUsage(result.usage)
    steps.push(usage)
    return { text: result.text, finishReason: result.finishReason, toolCalls: result.toolCalls.length, usage }
  }
  try {
    let answer = await ask(false)
    if (answer.toolCalls > 0) answer = await ask(true)
    if (answer.toolCalls > 0) return { ok: false, error: '摘要请求仍在调用工具' }
    return judged(answer, steps)
  } catch (error) {
    return failure(error, signal)
  }
}

export interface FlattenedSummaryInput {
  db: DB
  llm: Llm
  userId: number
  settings: UserSettings
  signal: AbortSignal
  date: string
  focus: string | null
  /** Builds the conversation text for an input budget, in tokens. */
  flatten: (budget: number) => string
}

/**
 * The summary from the compaction fallback model, for a conversation its own model can no longer
 * take (spec §3.4): the conversation flattened into one text, sized to the fallback's window, sent as
 * a fresh request without tools. Never falls back to the conversation's model.
 */
export async function summarizeFlattened(input: FlattenedSummaryInput): Promise<SummaryOutcome> {
  const resolved = await resolveServiceModel(input.db, input.userId, input.settings, { slot: 'compaction', accepts: canServeAsServiceModel })
  if (!resolved) return { ok: false, error: NO_FALLBACK_ERROR }
  const { provider, providerInterface, model } = resolved
  const limit = model.metadata_resolved.limit
  const maxOutputTokens = Math.min(MAX_SUMMARY_TOKENS, limit?.output || MAX_SUMMARY_TOKENS)
  const instruction = summaryInstruction({ date: input.date, focus: input.focus })
  const budget = (limit?.context || DEFAULT_FLATTEN_CONTEXT) - textTokens(instruction) - maxOutputTokens
  if (budget <= 0) return { ok: false, error: NO_FALLBACK_ERROR }
  const conversation = input.flatten(budget)
  try {
    const result = await generateText({
      model: await input.llm.createModel(provider, providerInterface, model),
      messages: [{ role: 'user', content: `<conversation>\n${conversation}\n</conversation>\n\n${instruction}` }],
      // Reasoning is off for every service job; inert on models that cannot switch it off.
      providerOptions: buildProviderOptions(providerInterface.protocol, { reasoning_enabled: false }, model.metadata_resolved),
      maxOutputTokens,
      abortSignal: input.signal,
    })
    const usage = toStepUsage(result.usage)
    return judged({ text: result.text, finishReason: result.finishReason, toolCalls: 0, usage }, [usage])
  } catch (error) {
    return failure(error, input.signal)
  }
}
