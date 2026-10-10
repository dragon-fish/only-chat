import type { Context } from 'cordis'
import { tool } from 'ai'
import { whileOffered } from '@/server/plugins/prompt-sections'
import manifest from '../manifest'
import { promptOptions } from '../library'
import { GENERATIVE_UI_PLUGIN_ID, RENDER_UI_TOOL_ID, RenderUiInputSchema } from '../shared'
import { serverLibrary, validateProgram } from './validate'

const GUIDANCE = [
  'You can draw interactive UI cards in the chat with the render_ui tool.',
  'Use it when a visual or interactive answer genuinely beats prose: comparisons, numbers and data, charts, choices the user picks from, small calculators and tools, quick forms. Answer in plain text otherwise — most replies need no UI.',
  'Buttons and forms that continue the conversation send a message as the user, so give them a clear message in the user\'s language. $variables, @Set and @Reset run locally in the UI and never reach you.',
  'Write UI text in the user\'s language. After render_ui succeeds, do not restate what the UI shows.',
].join('\n')

/** Generated once per isolate: the library is static, and the text is a few thousand tokens. */
const LANGUAGE_REFERENCE = serverLibrary.prompt(promptOptions)

export const GenerativeUiServerPlugin = {
  name: 'generative-ui',
  inject: ['tools', 'promptSections'] as const,
  apply(ctx: Context) {
    ctx.promptSections.register(GENERATIVE_UI_PLUGIN_ID, whileOffered(manifest, `${GUIDANCE}\n\n${LANGUAGE_REFERENCE}`))
    ctx.tools.register(GENERATIVE_UI_PLUGIN_ID, RENDER_UI_TOOL_ID, () => tool({
      description: 'Render an interactive UI card in the chat from an OpenUI Lang program (see the OpenUI Lang reference in the system prompt). Returns whether it rendered, or the exact errors to fix.',
      inputSchema: RenderUiInputSchema,
      execute: async input => validateProgram(input.code),
    }))
  },
}
