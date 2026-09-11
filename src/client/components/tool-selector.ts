import type { PluginConfigStatusMap, PluginManifest, PluginToolDescriptor } from '@/shared/plugins'

/**
 * One plugin as one switch. A plugin's tools are companions — `web_search` without `web_extract`,
 * or `read_file` without `write_file`, is a half-equipped model — so they are selected together and
 * the selector never offers them apart.
 */
export interface PluginGroupRow {
  id: string
  name: string
  description: string
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
export function availablePluginRows(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
  selected: readonly string[],
  status: PluginConfigStatusMap = {},
): PluginGroupRow[] {
  const selectedIds = new Set(selected)
  return [...manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(manifest => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      tools: manifest.tools,
      toolIds: manifest.tools.map(tool => tool.id),
      enabled: settings[manifest.id] === true,
      configured: pluginConfigured(manifest, status),
      selected: manifest.tools.some(tool => selectedIds.has(tool.id)),
    }))
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
