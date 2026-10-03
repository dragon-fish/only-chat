/**
 * Which paths this turn's own tool calls changed — written, edited, restored to, copied to, moved
 * from or to, or deleted. Lives in the turn's state, so it dies with the generation.
 *
 * It answers "did the caller do this itself?" for a plugin that tells the model about changes it
 * did not make: a file version records which conversation wrote it, but a move or a delete records
 * nothing of the kind.
 */
const TOUCHED_KEY = 'workspace_files:touched'

export function touchPaths(state: Map<string, unknown>, paths: Iterable<string>): void {
  const set = (state.get(TOUCHED_KEY) as Set<string> | undefined) ?? new Set<string>()
  for (const path of paths) set.add(path)
  state.set(TOUCHED_KEY, set)
}

export function touchedPaths(state: Map<string, unknown>): ReadonlySet<string> {
  return (state.get(TOUCHED_KEY) as Set<string> | undefined) ?? new Set()
}
