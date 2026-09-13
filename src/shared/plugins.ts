import { z } from 'zod'

/** Stable built-in IDs; persisted Conversation snapshots must never depend on display names. */
export const ASK_USER_PLUGIN_ID = 'ask_user' as const
export const ASK_USER_TOOL_ID = 'ask_user' as const
export const TAVILY_PLUGIN_ID = 'tavily' as const
export const WEB_SEARCH_TOOL_ID = 'web_search' as const
export const WEB_EXTRACT_TOOL_ID = 'web_extract' as const
export const DATETIME_PLUGIN_ID = 'datetime' as const
export const WORKSPACE_FILES_PLUGIN_ID = 'workspace_files' as const
export const LIST_FILES_TOOL_ID = 'list_files' as const
export const READ_FILE_TOOL_ID = 'read_file' as const
export const WRITE_FILE_TOOL_ID = 'write_file' as const
export const RESTORE_FILE_TOOL_ID = 'restore_file' as const
export const RENAME_FILE_TOOL_ID = 'rename_file' as const
export const DELETE_FILE_TOOL_ID = 'delete_file' as const
export const CURRENT_TIME_TOOL_ID = 'current_time' as const

export type BuiltInPluginId = typeof ASK_USER_PLUGIN_ID | typeof TAVILY_PLUGIN_ID | typeof DATETIME_PLUGIN_ID
  | typeof WORKSPACE_FILES_PLUGIN_ID
export type BuiltInToolId = typeof ASK_USER_TOOL_ID | typeof WEB_SEARCH_TOOL_ID | typeof WEB_EXTRACT_TOOL_ID | typeof CURRENT_TIME_TOOL_ID
  | typeof LIST_FILES_TOOL_ID | typeof READ_FILE_TOOL_ID | typeof WRITE_FILE_TOOL_ID | typeof RESTORE_FILE_TOOL_ID
  | typeof RENAME_FILE_TOOL_ID | typeof DELETE_FILE_TOOL_ID

/**
 * One tool's own identity. A plugin may own several, and each needs its own label: listing two
 * tools under one plugin name gives the selector two indistinguishable rows.
 */
export interface PluginToolDescriptor {
  id: string
  name: string
  description: string
}

/**
 * A set of tools that the selector offers as one switch. Companion tools — a search that is useless
 * without its extractor — belong in one group; a plugin whose tools are genuinely independent
 * declares them separately, or declares an empty `groups` to put every tool on its own row.
 */
export interface PluginToolGroup {
  id: string
  name: string
  description: string
  /** Tool ids from this manifest's own `tools`. */
  tools: readonly string[]
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

/**
 * A plugin's own page in settings, listed beside the built-in categories.
 *
 * Declared rather than derived from what the client plugin registered: navigation must be
 * answerable without loading every plugin, and an entry that appears only once its plugin happens
 * to be loaded would come and go for reasons a reader cannot see.
 */
export interface PluginSettingsEntry {
  label: string
  /** The plugin's own one-liner. Core renders whatever is declared and knows no plugin by name. */
  description?: string
}

/** Metadata that can be discovered without loading a plugin's client implementation. */
export interface PluginManifest {
  id: string
  name: string
  description: string
  /** Declaration order is the order the selector renders them in. */
  tools: readonly PluginToolDescriptor[]
  /**
   * Selection granularity. Omitted means the whole plugin is one group; a tool no declared group
   * claims becomes a row of its own, so a tool can never end up unselectable.
   */
  groups?: readonly PluginToolGroup[]
  /** Declared when the plugin has something to manage that a config form cannot be. */
  settingsEntry?: PluginSettingsEntry
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

export const PluginConfigStatusSchema = z.object({
  configured: z.boolean(),
  values: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.boolean()),
})

/**
 * Plugin pages a reader should see listed. A disabled plugin loses its shortcut but not its page —
 * its files still exist and still cost storage, and `/settings/plugins` always lists every plugin.
 */
export function pluginSettingsEntries(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
): Array<{ id: string, label: string, description: string, to: string }> {
  return manifests
    .filter(manifest => manifest.settingsEntry !== undefined && settings[manifest.id] === true)
    .map(manifest => ({
      id: manifest.id,
      label: manifest.settingsEntry!.label,
      description: manifest.settingsEntry!.description ?? '管理这个插件保存的数据',
      to: `/settings/plugins/${manifest.id}/data`,
    }))
}

export function pluginToolIds(manifest: PluginManifest): string[] {
  return manifest.tools.map(tool => tool.id)
}

/** A group with its tools resolved, which is what anything rendering or toggling a group needs. */
export interface ResolvedToolGroup {
  id: string
  name: string
  description: string
  tools: readonly PluginToolDescriptor[]
}

/** Every selectable group of one plugin, declared or implied. */
export function pluginToolGroups(manifest: PluginManifest): ResolvedToolGroup[] {
  if (manifest.groups === undefined) {
    return [{ id: manifest.id, name: manifest.name, description: manifest.description, tools: manifest.tools }]
  }
  const claimed = new Set<string>()
  const groups = manifest.groups.map((group) => {
    const tools = manifest.tools.filter((tool) => {
      if (!group.tools.includes(tool.id)) return false
      claimed.add(tool.id)
      return true
    })
    return { id: group.id, name: group.name, description: group.description, tools }
  }).filter(group => group.tools.length > 0)

  const loose = manifest.tools.filter(tool => !claimed.has(tool.id))
    .map(tool => ({ id: tool.id, name: tool.name, description: tool.description, tools: [tool] }))
  return [...groups, ...loose]
}

/**
 * A key that no field claims is treated as a secret. Being wrong in that direction hides a value
 * that did not need hiding; being wrong the other way broadcasts a credential.
 */
export function isSecretConfigKey(manifest: PluginManifest, key: string): boolean {
  const field = manifest.config?.find(candidate => candidate.key === key)
  return field === undefined || field.type === 'secret'
}
