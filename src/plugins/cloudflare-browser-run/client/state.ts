import { reactive } from 'vue'
import type { WorkspaceAttention } from '@/client/plugins/host'
import type { BrowserPluginCommand, BrowserSessionState } from '../shared'

/**
 * What this plugin's client knows about every conversation's browser, fed by `session` events.
 * Module-level on purpose: the tab, the cards and the setup function all read the same map, and
 * a plugin loads once per page.
 */
export const sessions = reactive(new Map<number, BrowserSessionState>())

let sender: ((command: BrowserPluginCommand) => boolean) | null = null
let attention: ((request?: WorkspaceAttention) => void) | null = null

export function bind(handlers: { send: typeof sender; attention: typeof attention }): void {
  sender = handlers.send
  attention = handlers.attention
}

export function sendCommand(command: BrowserPluginCommand): boolean {
  return sender?.(command) ?? false
}

export function requestAttention(request?: WorkspaceAttention): void {
  attention?.(request)
}

/** Applies a `session` event; returns true when the browser just came alive. */
export function applySession(state: BrowserSessionState): boolean {
  const before = sessions.get(state.conversation_id)
  sessions.set(state.conversation_id, state)
  return state.status === 'active' && before?.status !== 'active'
}
