import type { ClientPluginSetup } from '@/client/plugins/host'
import { GENERATE_IMAGE_TOOL_ID } from '@/shared/plugins'
import GenerateImageCard from './generate-image-card.vue'
import ImageNotification from './image-notification.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(GENERATE_IMAGE_TOOL_ID, GenerateImageCard)
  ctx.notifications.register(ImageNotification)
}
