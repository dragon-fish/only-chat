import type { DB } from '@/server/db/client'
import type { ContextDecision, ContextManager, StepInput, TurnInput } from '@/server/plugins/context-manager'
import type { CompactionEvent, ContextCompactionConfig } from '../shared'
import { loadAttachmentInfos } from './attachments'
import { composeCheckpoint, type ComposeDeps } from './compose'
import { isContextOverflow } from './overflow'
import { checkpointMessageId, estimateAttachmentIds, estimateNextRequest, isIneffective, pendingOf, triggerLine } from './trigger'

export const INEFFECTIVE_MESSAGE = '上下文仍然过长，建议开新会话或换更大窗口的模型'

export interface ManagerDeps extends ComposeDeps {
  db: DB
  config: (userId: number) => Promise<ContextCompactionConfig>
  /** Tells the person's clients something about one conversation. */
  notify: (event: Extract<CompactionEvent, { type: 'notice' }>) => Promise<void>
}

/** The plugin's context manager (spec §3.3): when to compact, and the summary itself. */
export function createContextManager(deps: ManagerDeps): ContextManager {
  /** Checkpoint + model pairs already reported as ineffective; this Durable Object's lifetime is plenty. */
  const reported = new Set<string>()

  const reportIneffective = (input: TurnInput | StepInput) => {
    const key = `${input.conversationId}:${checkpointMessageId(input.projection)}:${input.model.providerId}/${input.model.modelId}`
    if (reported.has(key)) return
    reported.add(key)
    deps.notify({ type: 'notice', conversationId: input.conversationId, kind: 'ineffective', message: INEFFECTIVE_MESSAGE })
      .catch(error => console.error('reporting ineffective compaction failed', error))
  }

  const judge = async (input: TurnInput | StepInput): Promise<ContextDecision> => {
    const line = triggerLine(input.model.contextLimit)
    if (line === null) return 'continue'
    if (!(await deps.config(input.userId)).auto) return 'continue'
    if (isIneffective(input, line)) {
      reportIneffective(input)
      return 'continue'
    }
    const pending = pendingOf(input)
    const infos = await loadAttachmentInfos(deps.db, input.userId, estimateAttachmentIds(input.projection, pending))
    return estimateNextRequest(input, pending, infos) > line ? 'checkpoint' : 'continue'
  }

  return {
    beforeTurn: judge,
    afterStep: judge,
    afterTurn: judge,
    isOverflow: isContextOverflow,
    compose: input => composeCheckpoint(deps, input),
  }
}
