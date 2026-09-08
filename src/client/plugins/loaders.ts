import type { PluginManifest } from '@/shared/plugins'
import type { ClientPluginLoader, ClientPluginModule } from './host'

const manifestModules = import.meta.glob('../../plugins/*/manifest.ts', { eager: true, import: 'default' })
const clientModules = import.meta.glob('../../plugins/*/client/index.ts')

export const pluginManifests = Object.values(manifestModules) as PluginManifest[]

/** Manifest modules are eager; client modules remain lazy chunks until the host asks for one. */
export const pluginLoaders: Record<string, ClientPluginLoader> = Object.fromEntries(
  Object.entries(clientModules).map(([path, load]) => {
    const pluginId = path.split('/').at(-3)
    if (!pluginId) throw new Error(`cannot determine plugin ID from ${path}`)
    return [pluginId, async () => load() as Promise<ClientPluginModule>]
  }),
)
