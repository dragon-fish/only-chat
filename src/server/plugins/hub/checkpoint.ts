import type { Message } from '@/shared/models'
import type { CheckpointPart } from '@/shared/parts'
import { checkpointOf, lastCheckpointIndex } from '@/shared/checkpoint'

/**
 * A path split at its last checkpoint (spec §1.3).
 *
 * `path` answers "may this turn reach it" — attachment visibility and the like stay on the whole
 * structural path, so a file uploaded before a compaction is still readable after it. `checkpoint`
 * and `visible` answer "has the model seen it": anything before the checkpoint was never sent again.
 */
export interface ContextProjection {
  path: readonly Message[]
  checkpoint: CheckpointPart | null
  /** Index of the checkpoint message in `path`. */
  checkpointIndex: number | null
  /** The messages after the checkpoint message; the whole path when there is none. */
  visible: readonly Message[]
}

export function projectContext(path: readonly Message[]): ContextProjection {
  const index = lastCheckpointIndex(path)
  if (index === null) return { path, checkpoint: null, checkpointIndex: null, visible: path }
  return { path, checkpoint: checkpointOf(path[index]!), checkpointIndex: index, visible: path.slice(index + 1) }
}
