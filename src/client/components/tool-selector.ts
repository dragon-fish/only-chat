import type { PluginManifest } from '@/shared/plugins'

export interface PluginToolRow {
  id: string
  pluginId: string
  pluginName: string
  pluginDescription: string
  enabled: boolean
  selected: boolean
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
