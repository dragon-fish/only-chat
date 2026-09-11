import type { PluginConfigStatusMap, PluginManifest } from '@/shared/plugins'

export interface PluginToolRow {
  id: string
  pluginId: string
  pluginName: string
  /** The tool's own label. Two tools under one plugin must not read as the same row. */
  name: string
  description: string
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

export function availablePluginRows(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
  selected: readonly string[],
  status: PluginConfigStatusMap = {},
): PluginToolRow[] {
  const selectedIds = new Set(selected)
  return [...manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap(manifest => manifest.tools.map(tool => ({
      id: tool.id,
      pluginId: manifest.id,
      pluginName: manifest.name,
      name: tool.name,
      description: tool.description,
      enabled: settings[manifest.id] === true,
      configured: pluginConfigured(manifest, status),
      selected: selectedIds.has(tool.id),
    })))
}

export function nextToolSelection(selected: readonly string[], toolId: string, on: boolean): string[] {
  const next = new Set(selected)
  if (on) next.add(toolId)
  else next.delete(toolId)
  return stableToolIds([...next])
}

export function toolSelectionSupported(
  selected: readonly string[],
  globallyAvailable: ReadonlySet<string>,
  modelSupportsTools: boolean,
): boolean {
  return modelSupportsTools || !selected.some(toolId => globallyAvailable.has(toolId))
}

export function conversationToolBlockReason(state: {
  draft: boolean
  settingsLoaded: boolean
  pending: boolean
  toolsSupported: boolean
}): string | null {
  if (state.draft && !state.settingsLoaded) return '正在加载插件设置…'
  if (state.pending) return '请先回答或取消当前问题'
  if (!state.toolsSupported) return '当前模型不支持工具调用，请更换模型或停用已选工具'
  return null
}
