import { tool } from 'ai'
import { ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID } from '@/shared/plugins'
import { AskUserInputSchema } from '../shared'

/** The missing `execute` is deliberate: this tool pauses for a durable human response. */
export const AskUserServerPlugin = {
  name: 'ask-user',
  inject: ['tools'] as const,
  apply(ctx: import('cordis').Context) {
    ctx.tools.register(ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID, () => tool({
      description: 'Ask the user one to three focused follow-up questions before continuing.',
      inputSchema: AskUserInputSchema,
    }))
  },
}
