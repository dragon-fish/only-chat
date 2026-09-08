/** Stable built-in IDs; persisted Session snapshots must never depend on display names. */
export const ASK_USER_PLUGIN_ID = 'ask_user' as const
export const ASK_USER_TOOL_ID = 'ask_user' as const

export type BuiltInPluginId = typeof ASK_USER_PLUGIN_ID
export type BuiltInToolId = typeof ASK_USER_TOOL_ID

/** Metadata that can be discovered without loading a plugin's client implementation. */
export interface PluginManifest {
  id: string
  name: string
  description: string
  defaultTools: readonly string[]
}
