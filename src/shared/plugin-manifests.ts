import type { PluginManifest } from './plugins'
import askUser from '@/plugins/ask-user/manifest'
import tavily from '@/plugins/tavily/manifest'
import datetime from '@/plugins/datetime/manifest'

/**
 * The one list both halves of the app read. The client used to discover manifests with
 * `import.meta.glob`, which the Worker cannot share: the server needs the same declarations to
 * know which config keys are secrets, and two discovery mechanisms would eventually disagree.
 */
export const pluginManifests: readonly PluginManifest[] = [askUser, tavily, datetime]

export function findPluginManifest(pluginId: string): PluginManifest | undefined {
  return pluginManifests.find(manifest => manifest.id === pluginId)
}
