import type { PluginManifest } from '@/shared/plugins'
import type { ClientPluginLoader, ClientPluginModule } from './host'

const manifestModules = import.meta.glob('../../plugins/*/manifest.ts', { eager: true, import: 'default' })
const clientModules = import.meta.glob('../../plugins/*/client/index.ts')

export const pluginManifests = Object.values(manifestModules) as PluginManifest[]

const manifestIdsByDirectory = new Map(
  Object.entries(manifestModules).map(([path, manifest]) => [
    path.slice(0, -'/manifest.ts'.length),
    (manifest as PluginManifest).id,
  ]),
)

/** Manifest modules are eager; client modules remain lazy chunks until the host asks for one. */
export const pluginLoaders: Record<string, ClientPluginLoader> = Object.fromEntries(
  Object.entries(clientModules).map(([path, load]) => {
    const directory = path.slice(0, -'/client/index.ts'.length)
    const pluginId = manifestIdsByDirectory.get(directory)
    if (!pluginId) throw new Error(`client plugin has no manifest: ${path}`)
    return [pluginId, async () => load() as Promise<ClientPluginModule>]
  }),
)
