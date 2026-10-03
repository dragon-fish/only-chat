/**
 * Whether this turn may reach `/memory/user` and `/memory/project`.
 *
 * The memory plugin opens them from `generation/prepare`; everything in this plugin that builds a
 * `WorkspaceScope` inside the hub reads the answer here. Kept in the turn's state rather than read
 * off the tool list so the dependency runs one way: memory knows about the workspace, never the
 * reverse.
 */
const MEMORY_OPEN_KEY = 'workspace_files:memory_open'

export function openMemoryMounts(state: Map<string, unknown>): void {
  state.set(MEMORY_OPEN_KEY, true)
}

export function memoryOpen(state: Map<string, unknown>): boolean {
  return state.get(MEMORY_OPEN_KEY) === true
}
