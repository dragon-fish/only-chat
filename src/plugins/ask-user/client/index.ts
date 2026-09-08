import AskUserCard from './ask-user-card.vue'
import type { ClientPluginSetup } from '@/client/plugins/host'
import { ASK_USER_TOOL_ID } from '@/shared/plugins'

export const setup: ClientPluginSetup = ctx => ctx.tools.register(ASK_USER_TOOL_ID, AskUserCard)
