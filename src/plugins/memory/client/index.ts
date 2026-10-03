import type { ClientPluginSetup } from '@/client/plugins/host'
import { MEMORY_SAVE_TOOL_ID } from '../shared'
import MemorySaveCard from './memory-save-card.vue'
import ProjectPanel from './project-panel.vue'
import SettingsPanel from './settings-panel.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(MEMORY_SAVE_TOOL_ID, MemorySaveCard)
  ctx.settingsPanel.register(SettingsPanel)
  ctx.projectPanel.register(ProjectPanel)
}
