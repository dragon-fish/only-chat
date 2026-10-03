import type { ClientPluginSetup } from '@/client/plugins/host'
import { MEMORY_SAVE_TOOL_ID } from '../shared'
import MemorySaveCard from './memory-save-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(MEMORY_SAVE_TOOL_ID, MemorySaveCard)
}
