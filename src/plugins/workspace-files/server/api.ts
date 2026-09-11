import type { Context } from 'cordis'
import { WORKSPACE_FILES_PLUGIN_ID } from '@/shared/plugins'
import { PREVIEW_SEGMENT, workspaceFileRoutes, workspacePreviewRoutes } from './routes'

/**
 * The plugin's HTTP surface. It runs on the Worker, where the API lives — the tool half of this
 * plugin runs inside the UserHub instead, so the two are separate cordis plugins rather than one
 * that would sit PENDING on whichever service its side does not have.
 */
export const WorkspaceFilesApiPlugin = {
  name: 'workspace-files-api',
  inject: ['pluginApi', 'db', 'assets', 'env', 'pluginConfig'] as const,
  apply(ctx: Context) {
    ctx.pluginApi.registerPublic(WORKSPACE_FILES_PLUGIN_ID, PREVIEW_SEGMENT, workspacePreviewRoutes(ctx))
    ctx.pluginApi.register(WORKSPACE_FILES_PLUGIN_ID, workspaceFileRoutes(ctx))
  },
}
