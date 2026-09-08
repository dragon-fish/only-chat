import type { PluginManifest } from '@/shared/plugins'

export interface PluginToolRow {
  id: string
  pluginId: string
  pluginName: string
  pluginDescription: string
  enabled: boolean
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

export function defaultToolsForSettings(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
): string[] {
  return stableToolIds(manifests.flatMap(manifest => settings[manifest.id] === true ? [...manifest.defaultTools] : []))
}

export function availablePluginRows(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
  selected: readonly string[],
): PluginToolRow[] {
  const selectedIds = new Set(selected)
  return [...manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap(manifest => [...manifest.defaultTools].sort().map(toolId => ({
      id: toolId,
      pluginId: manifest.id,
      pluginName: manifest.name,
      pluginDescription: manifest.description,
      enabled: settings[manifest.id] === true,
      selected: selectedIds.has(toolId),
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

export function sessionToolBlockReason(state: {
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
