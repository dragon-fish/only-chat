import type { Message } from './models'
import type { CheckpointPart } from './parts'

/**
 * The checkpoint a message is, or null (spec §1.1). Only an assistant message whose sole part is a
 * checkpoint counts: a checkpoint part anywhere else was not written by the checkpoint writer, and
 * honouring it would let any message erase the history before it.
 */
export function checkpointOf(message: Pick<Message, 'role' | 'parts'>): CheckpointPart | null {
  if (message.role !== 'assistant' || message.parts.length !== 1) return null
  const part = message.parts[0]!
  return part.type === 'checkpoint' ? part : null
}

/** Index of the last checkpoint message on a root → leaf path, or null when there is none. */
export function lastCheckpointIndex(path: readonly Pick<Message, 'role' | 'parts'>[]): number | null {
  for (let index = path.length - 1; index >= 0; index--) {
    if (checkpointOf(path[index]!)) return index
  }
  return null
}
