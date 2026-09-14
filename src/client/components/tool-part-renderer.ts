import type { Message } from '@/shared/models'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { humanToolDescriptor, humanToolDone, type PluginManifest } from '@/shared/plugins'
import { pluginManifests } from '@/shared/plugin-manifests'

function toolState(message: Message) {
  const calls = message.parts.filter((part): part is ToolCallPart => part.type === 'tool_call')
  const results = new Map(
    message.parts
      .filter((part): part is ToolResultPart => part.type === 'tool_result')
      .map(part => [part.call_id, part]),
  )
  return { calls, results }
}

export interface PendingHumanCall {
  messageId: number
  call: ToolCallPart
}

/** Which tools a person answers is read from the manifests, so no plugin has to be loaded to know. */
function isHuman(name: string, manifests: readonly PluginManifest[]): boolean {
  return humanToolDescriptor(manifests, name) !== undefined
}

/** The Composer only owns interactive calls on the current durable Conversation head. */
export function pendingHumanCalls(
  messages: readonly Message[],
  conversationHeadId: number | null | undefined,
  optimisticResultCallIds: ReadonlySet<string> = new Set(),
  manifests: readonly PluginManifest[] = pluginManifests,
): PendingHumanCall[] {
  const message = messages.find(candidate => candidate.id === conversationHeadId)
  if (!message || message.role !== 'assistant' || message.status !== 'done') return []
  const { calls, results } = toolState(message)
  return calls
    .filter(call => isHuman(call.name, manifests) && !results.has(call.id) && !optimisticResultCallIds.has(call.id))
    .map(call => ({ messageId: message.id, call }))
}

export function hasPendingToolCalls(messages: readonly Message[], manifests: readonly PluginManifest[] = pluginManifests): boolean {
  return messages.some((message) => {
    if (message.status !== 'done') return false
    const { calls, results } = toolState(message)
    return calls.some(call => isHuman(call.name, manifests) && !results.has(call.id))
  })
}

/**
 * Recovery is only valid for the current leaf after every question was answered. Tools that execute
 * may share the step with `ask_user`; their results carry no answer status and must not be asked
 * for one, or a model that searches and asks in one breath can never be resumed.
 */
export function canContinueToolMessage(
  message: Message,
  allMessages: readonly Message[],
  conversationHeadId: number | null | undefined,
  manifests: readonly PluginManifest[] = pluginManifests,
): boolean {
  if (conversationHeadId !== message.id) return false
  const { calls, results } = toolState(message)
  const questions = calls.flatMap((call) => {
    const descriptor = humanToolDescriptor(manifests, call.name)
    return descriptor ? [{ call, descriptor }] : []
  })
  if (!questions.length) return false
  if (questions.some(({ call, descriptor }) => {
    const result = results.get(call.id)
    return !result || !humanToolDone(descriptor, result.content)
  })) return false
  if (calls.some(call => !results.has(call.id))) return false
  return !allMessages.some(candidate => candidate.role === 'assistant' && candidate.parent_id === message.id)
}
