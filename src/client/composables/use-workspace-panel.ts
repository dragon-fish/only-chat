import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { ClientPluginHost, WorkspaceAttention } from '@/client/plugins/host'

const OPEN_KEY = 'oc.workspace.open'
const SIZE_KEY = 'oc.workspace.size'
/** Percent of the split the panel takes on desktop; the chat keeps the rest. */
export const DEFAULT_PANEL_SIZE = 40
export const MIN_PANEL_SIZE = 25
export const MAX_PANEL_SIZE = 70

export interface AttentionState {
  open: boolean
  /** The person collapsed the panel by hand in this conversation. */
  userCollapsed: boolean
  /** This plugin already opened the panel on its own once in this conversation. */
  autoOpened: boolean
  force: boolean
}

/**
 * Whether a plugin's request to be seen actually opens the panel. A handoff always does; anything
 * else gets one automatic opening per conversation and never overrides a person who closed it.
 */
export function shouldOpenForAttention(state: AttentionState): boolean {
  if (state.force) return true
  if (state.open) return false
  if (state.userCollapsed) return false
  return !state.autoOpened
}

function readStored<T>(key: string, parse: (raw: string) => T | undefined, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return parse(raw) ?? fallback
  } catch { return fallback }
}

function store(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* Private mode or a full store; the default is fine. */ }
}

/**
 * The shell's half of the workspace panel: open/closed and size remembered across sessions, the
 * active tab, and the attention policy applied to what plugins ask for. Tab availability is the
 * caller's (it depends on the conversation), which is why `tabs` is passed in.
 */
export function useWorkspacePanel(
  host: ClientPluginHost | null,
  scope: Ref<{ conversationId: number | null; tabs: readonly string[] }>,
) {
  const open = ref(readStored(OPEN_KEY, raw => raw === '1' ? true : raw === '0' ? false : undefined, false))
  const size = ref(readStored(SIZE_KEY, (raw) => {
    const value = Number(raw)
    return Number.isFinite(value) && value >= MIN_PANEL_SIZE && value <= MAX_PANEL_SIZE ? value : undefined
  }, DEFAULT_PANEL_SIZE))
  const tab = ref<string | null>(null)
  const userCollapsed = ref(false)
  const autoOpened = new Set<string>()

  watch(() => scope.value.conversationId, () => { userCollapsed.value = false })
  // A tab that disappeared (plugin disabled, conversation left its Project) falls back to the first.
  watch(() => scope.value.tabs, (tabs) => {
    if (tab.value === null || !tabs.includes(tab.value)) tab.value = tabs[0] ?? null
  }, { immediate: true })

  function show(pluginId?: string) {
    if (pluginId && scope.value.tabs.includes(pluginId)) tab.value = pluginId
    open.value = true
    store(OPEN_KEY, '1')
  }

  function hide() {
    open.value = false
    userCollapsed.value = true
    store(OPEN_KEY, '0')
  }

  function toggle() {
    if (open.value) hide()
    else show()
  }

  function resize(next: number) {
    size.value = next
    store(SIZE_KEY, String(next))
  }

  const stopAttention = host?.onWorkspaceAttention((pluginId: string, request: WorkspaceAttention) => {
    if (!scope.value.tabs.includes(pluginId)) return
    const key = `${scope.value.conversationId ?? 'draft'}:${pluginId}`
    const decision = shouldOpenForAttention({
      open: open.value,
      userCollapsed: userCollapsed.value,
      autoOpened: autoOpened.has(key),
      force: request.force === true,
    })
    autoOpened.add(key)
    if (decision) {
      tab.value = pluginId
      open.value = true
      store(OPEN_KEY, '1')
    } else if (open.value) {
      tab.value = pluginId
    }
  })
  onBeforeUnmount(() => stopAttention?.())

  return { open, size, tab, show, hide, toggle, resize }
}
