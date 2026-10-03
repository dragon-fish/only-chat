/**
 * Which memory mounts this turn may reach.
 *
 * The memory plugin opens them from `generation/prepare`, layer by layer; everything in this plugin
 * that builds a `WorkspaceScope` inside the hub reads the answer here. Kept in the turn's state
 * rather than read off the tool list so the dependency runs one way: memory knows about the
 * workspace, never the reverse.
 */
const MEMORY_OPEN_KEY = 'workspace_files:memory_open'

export interface OpenMemory {
  user: boolean
  project: boolean
}

const CLOSED: OpenMemory = { user: false, project: false }

export function openMemoryMounts(state: Map<string, unknown>, scopes: OpenMemory): void {
  state.set(MEMORY_OPEN_KEY, { user: scopes.user, project: scopes.project })
}

export function memoryOpen(state: Map<string, unknown>): OpenMemory {
  return (state.get(MEMORY_OPEN_KEY) as OpenMemory | undefined) ?? CLOSED
}
