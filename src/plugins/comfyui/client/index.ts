import type { ClientPluginSetup } from '@/client/plugins/host'
import TaskNotificationImages from '@/client/components/task-notification-images.vue'
import {
  COMFYUI_GENERATE_TOOL_ID, COMFYUI_LIST_MODELS_TOOL_ID, COMFYUI_LIST_WORKFLOWS_TOOL_ID, COMFYUI_NODE_INFO_TOOL_ID, COMFYUI_READ_TOOL_ID,
} from '@/shared/plugins'
import BrowseCard from './browse-card.vue'
import GenerateCard from './generate-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(COMFYUI_GENERATE_TOOL_ID, GenerateCard)
  for (const toolId of [COMFYUI_LIST_WORKFLOWS_TOOL_ID, COMFYUI_READ_TOOL_ID, COMFYUI_LIST_MODELS_TOOL_ID, COMFYUI_NODE_INFO_TOOL_ID]) {
    ctx.tools.register(toolId, BrowseCard)
  }
  ctx.notifications.register(TaskNotificationImages)
}
