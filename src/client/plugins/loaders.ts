import { ASK_USER_PLUGIN_ID, DATETIME_PLUGIN_ID, TAVILY_PLUGIN_ID } from '@/shared/plugins'
import { pluginManifests } from '@/shared/plugin-manifests'
import type { ClientPluginLoader, ClientPluginModule } from './host'

export { pluginManifests }

/**
 * Listed rather than globbed, next to the manifest barrel and the server's own explicit
 * registrations: one place says which plugins exist. Each entry stays a dynamic import, so a
 * plugin's client code is still a lazy chunk nobody downloads until a tool of its needs rendering.
 */
export const pluginLoaders: Record<string, ClientPluginLoader> = {
  [ASK_USER_PLUGIN_ID]: () => import('@/plugins/ask-user/client/index') as Promise<ClientPluginModule>,
  [TAVILY_PLUGIN_ID]: () => import('@/plugins/tavily/client/index') as Promise<ClientPluginModule>,
  [DATETIME_PLUGIN_ID]: () => import('@/plugins/datetime/client/index') as Promise<ClientPluginModule>,
}
