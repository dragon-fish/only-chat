import type { ClientPluginSetup } from '@/client/plugins/host'
import { ANALYZE_FILE_TOOL_ID } from '@/shared/plugins'
import AnalyzeFileCard from './analyze-file-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(ANALYZE_FILE_TOOL_ID, AnalyzeFileCard)
}
