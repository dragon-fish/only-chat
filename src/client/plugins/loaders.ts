import { ASK_USER_PLUGIN_ID, BROWSER_RUN_PLUGIN_ID, COMFYUI_PLUGIN_ID, DATETIME_PLUGIN_ID, FILE_READER_PLUGIN_ID, FILE_UNDERSTANDING_PLUGIN_ID, IMAGE_GENERATION_PLUGIN_ID, MCP_PLUGIN_ID, MEMORY_PLUGIN_ID, TAVILY_PLUGIN_ID, WORKSPACE_FILES_PLUGIN_ID } from '@/shared/plugins'
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
  [FILE_READER_PLUGIN_ID]: () => import('@/plugins/file-reader/client/index') as Promise<ClientPluginModule>,
  [IMAGE_GENERATION_PLUGIN_ID]: () => import('@/plugins/image-generation/client/index') as Promise<ClientPluginModule>,
  [WORKSPACE_FILES_PLUGIN_ID]: () => import('@/plugins/workspace-files/client/index') as Promise<ClientPluginModule>,
  [MEMORY_PLUGIN_ID]: () => import('@/plugins/memory/client/index') as Promise<ClientPluginModule>,
  [FILE_UNDERSTANDING_PLUGIN_ID]: () => import('@/plugins/file-understanding/client/index') as Promise<ClientPluginModule>,
  [BROWSER_RUN_PLUGIN_ID]: () => import('@/plugins/cloudflare-browser-run/client/index') as Promise<ClientPluginModule>,
  [MCP_PLUGIN_ID]: () => import('@/plugins/mcp/client/index') as Promise<ClientPluginModule>,
  [COMFYUI_PLUGIN_ID]: () => import('@/plugins/comfyui/client/index') as Promise<ClientPluginModule>,
}
