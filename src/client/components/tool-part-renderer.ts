import type { Message } from '@/shared/models'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'

function toolState(message: Message) {
  const calls = message.parts.filter((part): part is ToolCallPart => part.type === 'tool_call')
  const results = new Map(
    message.parts
      .filter((part): part is ToolResultPart => part.type === 'tool_result')
      .map(part => [part.call_id, part]),
  )
  return { calls, results }
}

export function hasPendingToolCalls(messages: readonly Message[]): boolean {
  return messages.some((message) => {
    const { calls, results } = toolState(message)
    return calls.some(call => !results.has(call.id))
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
  sessionHeadId: number | null | undefined,
): boolean {
  if (sessionHeadId !== message.id) return false
  const { calls, results } = toolState(message)
  if (!calls.length || calls.some(call => resultStatus(results.get(call.id)) !== 'answered')) return false
  return !allMessages.some(candidate => candidate.role === 'assistant' && candidate.parent_id === message.id)
}
