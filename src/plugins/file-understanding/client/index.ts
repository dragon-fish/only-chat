import type { ClientPluginSetup } from '@/client/plugins/host'
import { ANALYZE_FILE_TOOL_ID, VIEW_FILE_TOOL_ID } from '@/shared/plugins'
import AnalyzeFileCard from './analyze-file-card.vue'
import ViewFileCard from './view-file-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(VIEW_FILE_TOOL_ID, ViewFileCard)
  ctx.tools.register(ANALYZE_FILE_TOOL_ID, AnalyzeFileCard)
}
