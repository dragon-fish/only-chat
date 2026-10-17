import type { ClientPluginSetup } from '@/client/plugins/host'
import { WEB_EXTRACT_TOOL_ID, WEB_SEARCH_TOOL_ID } from '@/shared/plugins'
import WebExtractCard from './web-extract-card.vue'
import WebSearchCard from './web-search-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(WEB_SEARCH_TOOL_ID, WebSearchCard)
  ctx.tools.register(WEB_EXTRACT_TOOL_ID, WebExtractCard)
}
