import { tool } from 'ai'
import { ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID } from '@/shared/plugins'
import { whileOffered } from '@/server/plugins/prompt-sections'
import manifest from '../manifest'
import { AskUserInputSchema, AskUserResultSchema, validateAskUserResult } from '../shared'

/** When to ask at all. How to word a question is the tool's own description. */
const GUIDANCE = [
  'Ask the user with ask_user when their input would clear up an ambiguity, settle a choice between meaningful alternatives, or collect preferences before you go on.',
  'When a reasonable, easily reversible assumption is available, you may proceed on it and say so instead. A single open-ended question can usually just be asked in your reply.',
].join(' ')

const SKIPPED_MESSAGE = 'The user moved on without answering and said something else.'

/** The missing `execute` is deliberate: this tool pauses for a durable human response. */
export const AskUserServerPlugin = {
  name: 'ask-user',
  inject: ['tools', 'promptSections'] as const,
  apply(ctx: import('cordis').Context) {
    ctx.promptSections.register(ASK_USER_PLUGIN_ID, whileOffered(manifest, GUIDANCE))
    ctx.tools.register(ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID, () => tool({
      description: [
        'Ask the user 1-3 concise questions together, in a form they answer in the chat.',
        'Questions are optional by default so the user may skip them. Set required to true only when an answer is necessary.',
        'Skipped questions are returned in order with value null; this is a completed answer and generation should continue.',
        'Text questions are useful when collecting several answers together.',
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
