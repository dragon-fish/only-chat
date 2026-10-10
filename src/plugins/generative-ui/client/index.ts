import type { ClientPluginSetup } from '@/client/plugins/host'
import { RENDER_UI_TOOL_ID } from '../shared'
import RenderUiCard from './render-ui-card.vue'

export const setup: ClientPluginSetup = ctx => ctx.tools.register(RENDER_UI_TOOL_ID, RenderUiCard)
