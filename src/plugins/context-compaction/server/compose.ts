import type { UserSettings } from '@/shared/models'
import type { DB } from '@/server/db/client'
import type { Llm } from '@/server/plugins/llm'
import type { CheckpointDraft, ComposeInput } from '@/server/plugins/context-manager'
import { lastMeasuredStep, usageFromSteps } from '@/server/plugins/hub/compaction'
import { CONTEXT_COMPACTION_PLUGIN_ID, type CompactionData } from '../shared'
import { loadAttachmentInfos } from './attachments'
import { renderContent } from './content'
import { attachmentIdsOf, attachmentsTokens, MESSAGE_OVERHEAD_TOKENS, textTokens } from './estimate'
import { previousFiles, touchedFiles } from './files'
import { summaryInstruction, todayIso } from './instruction'
import { SERVICE_PROMPT_DEFAULTS } from '@/shared/service-prompts'
import { flattenConversation, recentTranscript, transcriptBudget } from './render'
import { MAX_SUMMARY_TOKENS, summarizeCached, summarizeFlattened, type SummaryOutcome } from './summarize'
import { estimateAttachmentIds, estimateNextRequest, triggerLine } from './trigger'

/** Less room than this for the summary, and the conversation's own model is not asked. */
const MIN_CACHED_OUTPUT_TOKENS = 2048

export interface ComposeDeps {
  db: DB
  llm: Llm
  /** The person's settings: the compaction instruction, and the fallback model when it is needed. */
  settings: (userId: number) => Promise<UserSettings>
  now?: () => Date
}

/**
 * How much the conversation's own model may write, or null when its window cannot also hold the
 * request and the instruction (spec §3.4): then only the fallback model can summarize.
 */
export function cachedOutputCap(input: Pick<ComposeInput, 'model' | 'trigger'>, estimate: number, instructionTokens: number): number | null {
  // The request that overflowed is the one a cached summary would resend.
  if (input.trigger === 'overflow') return null
  const { contextLimit, metadata } = input.model
  const cap = Math.min(MAX_SUMMARY_TOKENS, metadata.limit?.output || MAX_SUMMARY_TOKENS)
  if (contextLimit === null) return cap
  const room = Math.min(cap, contextLimit - estimate - instructionTokens)
  return room >= MIN_CACHED_OUTPUT_TOKENS ? room : null
}

/** The context manager's `compose` (spec §3.4, §3.6): the summary, the checkpoint's content, and every reason to refuse it. */
export async function composeCheckpoint(deps: ComposeDeps, input: ComposeInput): Promise<CheckpointDraft | { error: string }> {
  const { projection, turn } = input
  const pendingAttachments = turn?.pendingToolAttachments ?? []
  const carried = turn ? [...new Set([...turn.attachments, ...pendingAttachments])] : []
  const infos = await loadAttachmentInfos(deps.db, input.userId, [
    ...estimateAttachmentIds(projection, { pendingAttachments }),
    ...attachmentIdsOf(turn?.inputs ?? []),
    ...carried,
  ])

  // What the checkpoint replaces: the request the conversation would send next. One the provider
  // refused as too long was at least the window, whatever the estimate says.
  const estimated = estimateNextRequest({ projection, lastStep: lastMeasuredStep(projection.visible) }, { pendingAttachments }, infos)
  const before = input.trigger === 'overflow' && input.model.contextLimit !== null ? Math.max(estimated, input.model.contextLimit) : estimated
  const date = todayIso(deps.now?.())
  const settings = await deps.settings(input.userId)
  const template = settings.service_prompts?.compaction ?? SERVICE_PROMPT_DEFAULTS.compaction
  const cap = cachedOutputCap(input, before, textTokens(summaryInstruction({ template, date, focus: input.focus, strict: true })))

  let mode: CompactionData['mode']
  let outcome: SummaryOutcome
  if (cap !== null) {
    mode = 'cached'
    outcome = await summarizeCached({ request: input, signal: input.signal, maxOutputTokens: cap, template, date, focus: input.focus })
  } else {
    mode = 'flattened'
    const previous = projection.checkpoint?.content ?? null
    outcome = await summarizeFlattened({
      db: deps.db, llm: deps.llm, userId: input.userId, settings,
      signal: input.signal, template, date, focus: input.focus,
      flatten: budget => flattenConversation(previous, projection.visible, infos, budget),
    })
  }
  if (!outcome.ok) return { error: outcome.error }

  const checkpoint = projection.checkpoint
  const files = touchedFiles(projection.visible, checkpoint?.plugin === CONTEXT_COMPACTION_PLUGIN_ID ? previousFiles(checkpoint.data) : null)
  const content = renderContent({
    summary: outcome.summary,
    blocks: input.blocks,
    files,
    transcript: recentTranscript(projection.visible, infos, transcriptBudget(input.model.contextLimit)),
    inputs: turn ? turn.inputs : null,
    infos,
  })

  const after = MESSAGE_OVERHEAD_TOKENS + textTokens(content) + attachmentsTokens(carried, infos)
  if (after >= before) return { error: '压缩后的内容没有比原内容更小' }
  const line = triggerLine(input.model.contextLimit)
  if (line !== null && after > line) return { error: '这一轮的输入本身过大，压缩后仍超过触发线' }

  const data: CompactionData = {
    trigger: input.trigger, summary: outcome.summary, files, focus: input.focus, tokensBefore: before, mode,
  }
  return { content, attachments: carried, data, usage: usageFromSteps(outcome.steps) }
}
