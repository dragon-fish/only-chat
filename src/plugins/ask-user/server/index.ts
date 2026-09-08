import { tool } from 'ai'
import { ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID } from '@/shared/plugins'
import { AskUserInputSchema } from '../shared'

/** The missing `execute` is deliberate: this tool pauses for a durable human response. */
export const AskUserServerPlugin = {
  name: 'ask-user',
  inject: ['tools'] as const,
  apply(ctx: import('cordis').Context) {
    ctx.tools.register(ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID, () => tool({
      description: [
        'Ask the user only when missing preferences or decisions are needed before continuing.',
        'Prefer one short question and never ask more than three.',
        'For single-choice questions, provide 2-3 mutually exclusive options, put the recommended option first, and suffix its label with "(Recommended)".',
        'Use a text question when a free-form answer is needed instead of inventing an "Other" option.',
      ].join(' '),
      inputSchema: AskUserInputSchema,
    }))
  },
}
