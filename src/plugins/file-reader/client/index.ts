import type { ClientPluginSetup } from '@/client/plugins/host'
import { READ_FILE_TOOL_ID } from '@/shared/plugins'
import ReadFileCard from './read-file-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(READ_FILE_TOOL_ID, ReadFileCard)
}
