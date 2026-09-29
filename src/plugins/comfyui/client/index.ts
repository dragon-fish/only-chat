import type { ClientPluginSetup } from '@/client/plugins/host'
import TaskNotificationImages from '@/client/components/task-notification-images.vue'
import { COMFYUI_GENERATE_TOOL_ID } from '@/shared/plugins'
import GenerateCard from './generate-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(COMFYUI_GENERATE_TOOL_ID, GenerateCard)
  ctx.notifications.register(TaskNotificationImages)
}
