import type { ClientPluginSetup } from '@/client/plugins/host'
import { MCP_CALL_TOOL_TOOL_ID, MCP_LIST_SERVICES_TOOL_ID, MCP_LIST_TOOLS_TOOL_ID } from '../shared'
import CallToolCard from './call-tool-card.vue'
import ListCard from './list-card.vue'
import SettingsPanel from './settings-panel.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(MCP_LIST_SERVICES_TOOL_ID, ListCard)
  ctx.tools.register(MCP_LIST_TOOLS_TOOL_ID, ListCard)
  ctx.tools.register(MCP_CALL_TOOL_TOOL_ID, CallToolCard)
  // Servers are account-wide, so they are managed on the plugin's own page, not per conversation.
  ctx.settingsPanel.register(SettingsPanel)
}
