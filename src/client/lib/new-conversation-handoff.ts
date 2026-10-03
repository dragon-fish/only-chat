import type { Router } from 'vue-router'

/**
 * A message another page wants sent as the first turn of a new conversation, with the tools that
 * turn should offer. The new-conversation page sends it through its own send path, so creating
 * the conversation and jumping to it work exactly as if the person had typed it there.
 */
export interface NewConversationHandoff {
  prompt: string
  tools: string[]
}

const KEY = 'ocNewConversation'

/** Opens a new conversation (in a Project when given) that sends `prompt` as soon as it can. */
export async function startConversation(router: Router, projectId: number | null, handoff: NewConversationHandoff): Promise<void> {
  await router.push({ path: projectId === null ? '/new' : `/project/${projectId}/new`, state: { [KEY]: { ...handoff } } })
}

/**
 * The pending handoff, removed as it is read. History state survives a reload, so leaving it in
 * place would send the same message again every time the page is refreshed.
 */
export function takeHandoff(): NewConversationHandoff | null {
  const state = window.history.state as Record<string, unknown> | null
  const value = state?.[KEY] as NewConversationHandoff | undefined
  if (value === undefined) return null
  window.history.replaceState({ ...state, [KEY]: undefined }, '')
  return typeof value.prompt === 'string' && Array.isArray(value.tools) ? value : null
}
