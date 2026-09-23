import type { Message } from '@/shared/models'
import { isNotificationOnly, type TaskNotificationPart } from '@/shared/parts'

/** What a domain hands the hub when a background task it started has finished. */
export interface TaskSettlement {
  conversation_id: number
  /** The assistant message holding the tool call that started the task. */
  origin_message_id: number
  notification: TaskNotificationPart
}

/**
 * Notification-only user messages in a row, counting the one about to be written, after which the
 * server stops starting turns on its own. Without it, a turn started by a notification could start
 * another task, whose notification starts another turn, for as long as the money lasts.
 */
export const MAX_NOTIFICATION_TURNS = 5

/** DO storage keys of settled tasks not yet written into their conversation. */
export const TASK_STORAGE_PREFIX = 'task:'

export function deliveredTaskIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const part of message.parts) if (part.type === 'task_notification') ids.add(part.task_id)
  }
  return ids
}

/** A branch the person left behind never started this task, so its outcome is not news there. */
export function originOnPath(path: readonly Message[], originId: number): boolean {
  return path.some(message => message.id === originId)
}

export function notificationTurnsSinceHuman(path: readonly Message[]): number {
  let count = 0
  for (let index = path.length - 1; index >= 0; index--) {
    const message = path[index]!
    if (message.role !== 'user') continue
    if (!isNotificationOnly(message.parts)) break
    count++
  }
  return count
}

/**
 * A question to the person keeps the floor. Sending on top of it would auto-skip the question
 * (see `resolveSendParent`), so a notification waits until the question is answered.
 */
export function awaitsHuman(head: Message | undefined, isHuman: (toolName: string) => boolean): boolean {
  if (head?.role !== 'assistant') return false
  const answered = new Set(head.parts.flatMap(part => (part.type === 'tool_result' ? [part.call_id] : [])))
  return head.parts.some(part => part.type === 'tool_call' && isHuman(part.name) && !answered.has(part.id))
}
