import type { z } from 'zod'

/** Stable built-in IDs; persisted Conversation snapshots must never depend on display names. */
export const ASK_USER_PLUGIN_ID = 'ask_user' as const
export const ASK_USER_TOOL_ID = 'ask_user' as const
export const TAVILY_PLUGIN_ID = 'tavily' as const
export const WEB_SEARCH_TOOL_ID = 'web_search' as const
export const WEB_EXTRACT_TOOL_ID = 'web_extract' as const

export type BuiltInPluginId = typeof ASK_USER_PLUGIN_ID | typeof TAVILY_PLUGIN_ID
export type BuiltInToolId = typeof ASK_USER_TOOL_ID | typeof WEB_SEARCH_TOOL_ID | typeof WEB_EXTRACT_TOOL_ID

/**
 * One tool's own identity. A plugin may own several, and each needs its own label: listing two
 * tools under one plugin name gives the selector two indistinguishable rows.
 */
export interface PluginToolDescriptor {
  id: string
  name: string
  description: string
}

export type PluginConfigFieldType = 'text' | 'secret' | 'number' | 'boolean' | 'select'

/**
 * Presentation only. Options, bounds and defaults are read from `configSchema` via
 * `z.toJSONSchema`; declaring them here too would let the two drift apart.
 */
export interface PluginConfigField {
  key: string
  label: string
  help: string
  type: PluginConfigFieldType
  placeholder?: string
}

/** A credential form is half about what you type in and half about where to get it. */
export interface PluginConfigIntro {
  why: string
  where?: string
  link?: { label: string; href: string }
}

/** Metadata that can be discovered without loading a plugin's client implementation. */
export interface PluginManifest {
  id: string
  name: string
  description: string
  /** Declaration order is the order the selector renders them in. */
  tools: readonly PluginToolDescriptor[]
  /**
   * The authority on this plugin's configuration. The server parses every read and write through
   * it; the client derives its form controls from it. `.refine()` rules and custom messages do not
   * survive `z.toJSONSchema`, so client-side validation is permanently a subset of this.
   */
  configSchema?: z.ZodObject
  /** Declaration order is the form's field order. */
  config?: readonly PluginConfigField[]
  configIntro?: PluginConfigIntro
}

/**
 * What a client is allowed to know about stored configuration. Ordinary values come back verbatim
 * because the form has to show them to edit them; a secret is reduced to whether one is stored.
 * `configured` is the server's answer to "would this plugin's tools run?" — the client cannot work
 * it out itself, because the values that decide it are exactly the ones it never receives.
 */
export interface PluginConfigStatus {
  configured: boolean
  values: Record<string, unknown>
  secrets: Record<string, boolean>
}

export type PluginConfigStatusMap = Record<string, PluginConfigStatus>

export function pluginToolIds(manifest: PluginManifest): string[] {
  return manifest.tools.map(tool => tool.id)
}

/**
 * A key that no field claims is treated as a secret. Being wrong in that direction hides a value
 * that did not need hiding; being wrong the other way broadcasts a credential.
 */
export function isSecretConfigKey(manifest: PluginManifest, key: string): boolean {
  const field = manifest.config?.find(candidate => candidate.key === key)
  return field === undefined || field.type === 'secret'
}
