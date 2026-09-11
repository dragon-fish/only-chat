import type { ClientPluginSetup } from '@/client/plugins/host'
import { CURRENT_TIME_TOOL_ID } from '@/shared/plugins'
import CurrentTimeCard from './current-time-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(CURRENT_TIME_TOOL_ID, CurrentTimeCard)
}
