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
        'Questions are optional by default so the user may skip them. Set required to true only when an answer is necessary.',
        'Skipped questions are returned in order with value null; this is a completed answer and generation should continue.',
        'Do not use this tool for a single open-ended text question; ask that question normally in chat. Text questions are useful when collecting multiple answers together.',
        'For single-choice questions, provide 2-3 mutually exclusive options, put the recommended option first, and suffix its label with "(Recommended)".',
        'Choice questions allow one custom "Other" answer by default. Set allowOther to false only when a custom answer would be invalid.',
      ].join(' '),
      inputSchema: AskUserInputSchema,
    }))
  },
}
