import type { PluginConfigStatusMap, PluginManifest, PluginToolDescriptor } from '@/shared/plugins'
import { pluginToolGroups } from '@/shared/plugins'

/**
 * One declared tool group as one switch. Which tools travel together is the plugin's own call, so
 * this type only carries the decision out to the UI; it never regroups anything itself.
 */
export interface ToolGroupRow {
  /** Group ids are unique only inside a plugin, so a row is addressed by both. */
  id: string
  name: string
  description: string
  pluginId: string
  pluginName: string
  tools: readonly PluginToolDescriptor[]
  /** Every tool id this row writes into the Conversation snapshot. */
  toolIds: string[]
  enabled: boolean
  configured: boolean
  selected: boolean
}

interface PluginLoader { ensurePlugin(pluginId: string): Promise<void> }
type PluginLoadReporter = (pluginId: string, error: unknown) => void

export async function ensureSelectedPlugins(
  host: PluginLoader,
  pluginIds: readonly string[],
  report: PluginLoadReporter = (pluginId, error) => console.error(`Failed to load client plugin ${pluginId}`, error),
): Promise<void> {
  await Promise.all([...new Set(pluginIds)].map(async (pluginId) => {
    try { await host.ensurePlugin(pluginId) }
    catch (error) { report(pluginId, error) }
  }))
}

export function stableToolIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

/**
 * A plugin that declares no configuration is always ready. One that does is ready only when the
 * server says so — the client never holds the secrets that decide it.
 */
export function pluginConfigured(manifest: PluginManifest, status: PluginConfigStatusMap): boolean {
  return manifest.configSchema === undefined || status[manifest.id]?.configured === true
}

/**
 * What a new conversation starts with. An enabled-but-unconfigured plugin is deliberately excluded:
 * auto-selecting its tools would fail every generation until someone filled in a credential they
 * were never told was missing.
 */
export function defaultToolsForSettings(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
  status: PluginConfigStatusMap = {},
): string[] {
  return stableToolIds(manifests.flatMap(manifest => (
    settings[manifest.id] === true && pluginConfigured(manifest, status)
      ? manifest.tools.map(tool => tool.id)
      : []
  )))
}

/**
 * What the selector lists. A plugin switched off globally is hidden unless this Conversation's
 * snapshot still names one of its tools: an offer nobody can accept is noise, but a tool this
 * conversation has been using has to stay visible and switchable off.
 */
export function availableToolGroups(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
  selected: readonly string[],
  status: PluginConfigStatusMap = {},
): ToolGroupRow[] {
  const selectedIds = new Set(selected)
  return [...manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap(manifest => pluginToolGroups(manifest).map(group => ({
      id: `${manifest.id}:${group.id}`,
      name: group.name,
      description: group.description,
      pluginId: manifest.id,
      pluginName: manifest.name,
      tools: group.tools,
      toolIds: group.tools.map(tool => tool.id),
      enabled: settings[manifest.id] === true,
      configured: pluginConfigured(manifest, status),
      selected: group.tools.some(tool => selectedIds.has(tool.id)),
    })))
    .filter(row => row.enabled || row.selected)
}

/** Switching a group on adds every tool it owns, which also repairs a half-selected old snapshot. */
export function nextToolSelection(selected: readonly string[], toolIds: readonly string[], on: boolean): string[] {
  const next = new Set(selected)
  for (const toolId of toolIds) {
    if (on) next.add(toolId)
    else next.delete(toolId)
  }
  return stableToolIds([...next])
}

export function conversationToolBlockReason(state: {
  draft: boolean
  settingsLoaded: boolean
  pending: boolean
}): string | null {
  if (state.draft && !state.settingsLoaded) return '正在加载插件设置…'
  if (state.pending) return '请先回答或取消当前问题'
  return null
}
