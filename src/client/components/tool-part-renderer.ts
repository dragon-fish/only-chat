import type { Message } from '@/shared/models'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { ASK_USER_TOOL_ID } from '@/shared/plugins'
import { AskUserInputSchema } from '@/plugins/ask-user/shared'

function toolState(message: Message) {
  const calls = message.parts.filter((part): part is ToolCallPart => part.type === 'tool_call')
  const results = new Map(
    message.parts
      .filter((part): part is ToolResultPart => part.type === 'tool_result')
      .map(part => [part.call_id, part]),
  )
  return { calls, results }
}

export interface PendingAskUserCall {
  messageId: number
  call: ToolCallPart
}

/** The Composer only owns interactive calls on the current durable Conversation head. */
export function pendingAskUserCalls(
  messages: readonly Message[],
  conversationHeadId: number | null | undefined,
  optimisticResultCallIds: ReadonlySet<string> = new Set(),
): PendingAskUserCall[] {
  const message = messages.find(candidate => candidate.id === conversationHeadId)
  if (!message || message.role !== 'assistant' || message.status !== 'done') return []
  const { calls, results } = toolState(message)
  return calls
    .filter(call => (
      call.name === ASK_USER_TOOL_ID
      && AskUserInputSchema.safeParse(call.args).success
      && !results.has(call.id)
      && !optimisticResultCallIds.has(call.id)
    ))
    .map(call => ({ messageId: message.id, call }))
}

export function hasPendingToolCalls(messages: readonly Message[]): boolean {
  return messages.some((message) => {
    if (message.status !== 'done') return false
    const { calls, results } = toolState(message)
    return calls.some(call => (
      call.name === ASK_USER_TOOL_ID
      && AskUserInputSchema.safeParse(call.args).success
      && !results.has(call.id)
    ))
  })
}

function resultStatus(result: ToolResultPart | undefined): unknown {
  const content = result?.content
  return typeof content === 'object' && content !== null && 'status' in content
    ? (content as { status?: unknown }).status
    : undefined
}

/** Recovery is only valid for the current leaf after every sibling call was answered. */
export function canContinueToolMessage(
  message: Message,
  allMessages: readonly Message[],
  conversationHeadId: number | null | undefined,
): boolean {
  if (conversationHeadId !== message.id) return false
  const { calls, results } = toolState(message)
  if (!calls.length || calls.some(call => resultStatus(results.get(call.id)) !== 'answered')) return false
  return !allMessages.some(candidate => candidate.role === 'assistant' && candidate.parent_id === message.id)
}
