import { z } from 'zod'
import type { ConversationPluginSettings } from './models'

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
export const EDIT_FILE_TOOL_ID = 'edit_file' as const
export const RESTORE_FILE_TOOL_ID = 'restore_file' as const
export const RENAME_FILE_TOOL_ID = 'rename_file' as const
export const DELETE_FILE_TOOL_ID = 'delete_file' as const
export const PREVIEW_FILE_TOOL_ID = 'preview_file' as const
export const COPY_FILE_TOOL_ID = 'copy_file' as const
export const FILE_READER_PLUGIN_ID = 'file_reader' as const
export const FILE_UNDERSTANDING_PLUGIN_ID = 'file_understanding' as const
export const VIEW_FILE_TOOL_ID = 'view_file' as const
export const ANALYZE_FILE_TOOL_ID = 'analyze_file' as const
export const CURRENT_TIME_TOOL_ID = 'current_time' as const
export const BROWSER_RUN_PLUGIN_ID = 'cloudflare_browser_run' as const
export const BROWSER_USE_TOOL_ID = 'browser_use' as const
export const BROWSER_HANDOFF_TOOL_ID = 'browser_handoff' as const
export const IMAGE_GENERATION_PLUGIN_ID = 'image_generation' as const
export const GENERATE_IMAGE_TOOL_ID = 'generate_image' as const

export type BuiltInPluginId = typeof ASK_USER_PLUGIN_ID | typeof TAVILY_PLUGIN_ID | typeof DATETIME_PLUGIN_ID
  | typeof WORKSPACE_FILES_PLUGIN_ID | typeof BROWSER_RUN_PLUGIN_ID | typeof IMAGE_GENERATION_PLUGIN_ID
  | typeof FILE_UNDERSTANDING_PLUGIN_ID
export type BuiltInToolId = typeof ASK_USER_TOOL_ID | typeof WEB_SEARCH_TOOL_ID | typeof WEB_EXTRACT_TOOL_ID | typeof CURRENT_TIME_TOOL_ID
  | typeof LIST_FILES_TOOL_ID | typeof READ_FILE_TOOL_ID | typeof WRITE_FILE_TOOL_ID | typeof EDIT_FILE_TOOL_ID | typeof RESTORE_FILE_TOOL_ID
  | typeof RENAME_FILE_TOOL_ID | typeof DELETE_FILE_TOOL_ID | typeof PREVIEW_FILE_TOOL_ID | typeof COPY_FILE_TOOL_ID
  | typeof VIEW_FILE_TOOL_ID | typeof ANALYZE_FILE_TOOL_ID
  | typeof BROWSER_USE_TOOL_ID | typeof BROWSER_HANDOFF_TOOL_ID | typeof GENERATE_IMAGE_TOOL_ID

/**
 * One tool's own identity. A plugin may own several, and each needs its own label: listing two
 * tools under one plugin name gives the selector two indistinguishable rows.
 */
export interface PluginToolDescriptor {
  id: string
  name: string
  description: string
  /**
   * Set when the server cannot answer this tool and the generation stops for a person. The
   * statuses name the results that mean "the person is done", so the client can tell an answered
   * call from one the person walked away from without knowing the plugin's result shape.
   */
  human?: { doneStatuses: readonly string[] }
}

export function humanToolDescriptor(manifests: readonly PluginManifest[], toolId: string): PluginToolDescriptor | undefined {
  for (const manifest of manifests) {
    const tool = manifest.tools.find(candidate => candidate.id === toolId)
    if (tool) return tool.human ? tool : undefined
  }
  return undefined
}

/** Whether a human tool's recorded result is one the person finished, by the manifest's own list. */
export function humanToolDone(descriptor: PluginToolDescriptor, content: unknown): boolean {
  const status = typeof content === 'object' && content !== null && 'status' in content
    ? (content as { status?: unknown }).status
    : undefined
  return typeof status === 'string' && (descriptor.human?.doneStatuses.includes(status) ?? false)
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

/** A tab in the chat view's workspace panel. Declared so the tab strip needs no plugin loaded. */
export interface PluginWorkspaceTab {
  label: string
}

/** Metadata that can be discovered without loading a plugin's client implementation. */
export interface PluginManifest {
  id: string
  name: string
  description: string
  /** Its tools only make sense inside a Project; a conversation without one is never offered them. */
  requiresProject?: boolean
  /**
   * Plugins this one cannot work without. The switch and selection counterpart of the server half
   * injecting their services: whatever its server `inject`s from another plugin must be listed here,
   * which a test checks. Enabling this enables them; disabling one of them disables this.
   */
  requires?: readonly string[]
  workspaceTab?: PluginWorkspaceTab
  /**
   * Settings kept per conversation rather than per user, validated the same way `configSchema` is.
   * Defaults live in the schema, so a conversation that never touched them parses to the defaults.
   */
  conversationConfigSchema?: z.ZodObject
  /** Declaration order is the form's field order, rendered inside conversation settings. */
  conversationConfig?: readonly PluginConfigField[]
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

/** `start` and everything it requires, transitively. Unknown ids are carried through untouched. */
export function requiredPlugins(manifests: readonly PluginManifest[], start: readonly string[]): Set<string> {
  const byId = new Map(manifests.map(manifest => [manifest.id, manifest]))
  const found = new Set<string>()
  const visit = (id: string) => {
    if (found.has(id)) return
    found.add(id)
    for (const next of byId.get(id)?.requires ?? []) visit(next)
  }
  for (const id of start) visit(id)
  return found
}

/** `start` and everything that requires it, transitively. */
export function dependentPlugins(manifests: readonly PluginManifest[], start: readonly string[]): Set<string> {
  const found = new Set<string>()
  const visit = (id: string) => {
    if (found.has(id)) return
    found.add(id)
    for (const manifest of manifests) if (manifest.requires?.includes(id)) visit(manifest.id)
  }
  for (const id of start) visit(id)
  return found
}

/**
 * The switches a change really flips: turning a plugin on turns on what it requires, turning one off
 * turns off what requires it. Applied on the server to every settings patch, so no client can leave
 * a plugin enabled without the ones it needs.
 */
export function cascadePluginSwitches(
  manifests: readonly PluginManifest[],
  patch: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const on = Object.keys(patch).filter(id => patch[id] === true)
  const off = Object.keys(patch).filter(id => patch[id] === false)
  const out: Record<string, boolean> = {}
  for (const id of dependentPlugins(manifests, off)) out[id] = false
  // A patch that both enables a plugin and disables what it needs keeps the enabled side working.
  for (const id of requiredPlugins(manifests, on)) out[id] = true
  return out
}

/**
 * The switches as they take effect: an enabled plugin's requirements count as enabled even when the
 * stored settings predate the requirement. Read through this everywhere a switch decides anything,
 * so settings saved before a plugin gained a dependency never leave it without one.
 */
export function effectivePluginSwitches(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...settings }
  for (const id of requiredPlugins(manifests, Object.keys(settings).filter(id => settings[id] === true))) out[id] = true
  return out
}

/** The plugin each tool id belongs to. */
export function toolOwners(manifests: readonly PluginManifest[]): Map<string, string> {
  return new Map(manifests.flatMap(manifest => manifest.tools.map(tool => [tool.id, manifest.id] as const)))
}

/**
 * A tool selection with every required plugin's tools added. Selecting a tool of a plugin selects
 * the plugins it needs; the server applies this at generation start rather than trusting a stored
 * snapshot to already satisfy it.
 */
export function withRequiredTools(manifests: readonly PluginManifest[], toolIds: readonly string[]): string[] {
  const owners = toolOwners(manifests)
  const selectedPlugins = [...new Set(toolIds.flatMap(id => owners.get(id) ?? []))]
  const needed = requiredPlugins(manifests, selectedPlugins)
  const out = new Set(toolIds)
  for (const manifest of manifests) {
    if (needed.has(manifest.id) && !selectedPlugins.includes(manifest.id)) for (const tool of manifest.tools) out.add(tool.id)
  }
  return [...out]
}

/** A tool selection with `toolIds` removed, along with the tools of every plugin that required their plugins. */
export function withoutDependentTools(manifests: readonly PluginManifest[], selected: readonly string[], toolIds: readonly string[]): string[] {
  const owners = toolOwners(manifests)
  const removed = new Set(toolIds)
  // Only a plugin losing every selected tool stops serving its dependents.
  const gone = [...new Set(toolIds.flatMap(id => owners.get(id) ?? []))]
    .filter(pluginId => !selected.some(id => !removed.has(id) && owners.get(id) === pluginId))
  const dropped = dependentPlugins(manifests, gone)
  return selected.filter(id => !removed.has(id) && !dropped.has(owners.get(id) ?? ''))
}

/** Where a conversation lives decides which plugins can serve it. */
export interface ConversationScope {
  projectId: number | null
}

export function pluginAvailableIn(manifest: PluginManifest, scope: ConversationScope): boolean {
  return manifest.requiresProject !== true || scope.projectId !== null
}

export interface WorkspaceTabEntry {
  pluginId: string
  label: string
}

/** The workspace panel's tab strip, answerable from manifests alone: enabled plugins that can serve here. */
export function workspaceTabs(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
  scope: ConversationScope,
): WorkspaceTabEntry[] {
  return manifests
    .filter(manifest => manifest.workspaceTab !== undefined && settings[manifest.id] === true && pluginAvailableIn(manifest, scope))
    .map(manifest => ({ pluginId: manifest.id, label: manifest.workspaceTab!.label }))
}

/** This plugin's per-conversation settings with defaults applied; `{}` when it declares none. */
export function conversationConfigOf(
  manifest: PluginManifest,
  settings: ConversationPluginSettings | null | undefined,
): Record<string, unknown> {
  if (!manifest.conversationConfigSchema) return {}
  return manifest.conversationConfigSchema.parse(settings?.[manifest.id] ?? {}) as Record<string, unknown>
}

/**
 * Validates what a client sent, entry by entry. A plugin that declares no conversation settings is
 * refused rather than stored: an opaque blob nobody validates is how a bad value survives forever.
 */
export function parseConversationPluginSettings(
  manifests: readonly PluginManifest[],
  settings: ConversationPluginSettings,
): ConversationPluginSettings {
  const out: ConversationPluginSettings = {}
  for (const [pluginId, values] of Object.entries(settings)) {
    const manifest = manifests.find(candidate => candidate.id === pluginId)
    if (!manifest?.conversationConfigSchema) throw new Error(`plugin ${pluginId} has no conversation settings`)
    out[pluginId] = manifest.conversationConfigSchema.parse(values) as Record<string, unknown>
  }
  return out
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

