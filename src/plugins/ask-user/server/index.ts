import { tool } from 'ai'
import { ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID } from '@/shared/plugins'
import { AskUserInputSchema, AskUserResultSchema, validateAskUserResult } from '../shared'

const SKIPPED_MESSAGE = '用户跳过了问题并继续回复'

/** The missing `execute` is deliberate: this tool pauses for a durable human response. */
export const AskUserServerPlugin = {
  name: 'ask-user',
  inject: ['tools'] as const,
  apply(ctx: import('cordis').Context) {
    ctx.tools.register(ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID, () => tool({
      description: [
        'Ask the user when their input would help clarify ambiguity, choose between meaningful alternatives, or collect preferences before continuing.',
        'Ask 1-3 concise questions together when practical. If a reasonable, easily reversible assumption is available, you may proceed and state it instead.',
        'Questions are optional by default so the user may skip them. Set required to true only when an answer is necessary.',
        'Skipped questions are returned in order with value null; this is a completed answer and generation should continue.',
        'A single open-ended question can usually be asked directly in chat. Text questions are useful when collecting multiple answers together.',
        'For choice questions, provide 2-3 distinct options. When one option has a concrete advantage, place it first and suffix its label with "(Recommended)"; otherwise present the choices without a recommendation.',
        'Choice questions allow one custom "Other" answer by default. Set allowOther to false only when a custom answer would be invalid.',
      ].join(' '),
      inputSchema: AskUserInputSchema,
    }), {
      respond: (input, result) => validateAskUserResult(AskUserInputSchema.parse(input), AskUserResultSchema.parse(result)),
      // Not parsed: a person walking away from a malformed question must not be told they cannot.
      skip: () => ({ status: 'cancelled', message: SKIPPED_MESSAGE }),
      // `invalid` is not a skip. A skip is a person deciding not to answer, and generation waits
      // for them to say something next; a malformed call is the model's own mistake, and it should
      // be handed straight back so the turn can carry on and get it right.
      skipped: content => AskUserResultSchema.parse(content).status === 'cancelled',
    })
  },
}
