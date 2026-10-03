import type { Context } from 'cordis'
import { tool } from 'ai'
import { TAVILY_PLUGIN_ID, WEB_EXTRACT_TOOL_ID, WEB_SEARCH_TOOL_ID } from '@/shared/plugins'
import type { ToolContext } from '@/server/plugins/tools'
import {
  MAX_EXTRACT_URLS, TAVILY_CONFIG_SCHEMA, WebExtractInputSchema, WebSearchInputSchema, type TavilyConfig,
} from '../shared'
import { whileOffered } from '@/server/plugins/prompt-sections'
import manifest from '../manifest'
import { TavilyClient } from './client'
import { runWebExtract, runWebSearch } from './runners'

/** Each tool builds its own client; both read the one configuration the registry already parsed. */
function configOf(ctx: ToolContext): TavilyConfig {
  return TAVILY_CONFIG_SCHEMA.parse(ctx.config)
}

function clientOf(config: TavilyConfig): TavilyClient {
  return new TavilyClient({ apiKey: config.api_key, searchDepth: config.search_depth })
}

/**
 * Says when the budget resets rather than calling it a "turn": a model reading "this turn" cannot
 * tell whether that means this reply or the whole conversation, and guesses the expensive way.
 * Carries no configured number, so it stays constant and costs no prompt cache.
 */
const TURN_LIMIT_TIP = 'This tool has a call limit. The budget resets each time the user speaks; the remaining count comes back with every result.'

/** When to search, and how the two tools follow each other. Each tool's own text is its call. */
const GUIDANCE = [
  'Search the web when the answer depends on current information (recent news, prices, results, releases), on facts from after your training data, on a niche specialist topic, or when the user asks for a search. Not for stable general knowledge, small talk, or what the conversation already answers.',
  'The usual path is web_search, then — only when the excerpts lack a specific number, step or full explanation, or the user names a page to read — web_extract on the 1-3 most relevant URLs in a single call.',
  'When results miss, search again with different keywords: add the year, switch language, name the platform. When the budget runs out with nothing found, say so; do not split the query to get around the limit.',
].join('\n')

const SEARCH_DESCRIPTION = [
  'Searches the web and returns titles, URLs and excerpts.',
  TURN_LIMIT_TIP,
].join('\n')

const EXTRACT_DESCRIPTION = [
  `Fetches the body text of up to ${MAX_EXTRACT_URLS} pages as markdown. Slower and more expensive than web_search.`,
  'Pass only URLs that came from a search result or from the user.',
  'A URL that fails is marked on its own; one failure does not void the rest of the batch.',
  TURN_LIMIT_TIP,
].join('\n')

export const TavilyServerPlugin = {
  name: 'tavily',
  inject: ['tools', 'promptSections'] as const,
  apply(ctx: Context) {
    ctx.promptSections.register(TAVILY_PLUGIN_ID, whileOffered(manifest, GUIDANCE))
    ctx.tools.register(TAVILY_PLUGIN_ID, WEB_SEARCH_TOOL_ID, toolCtx => tool({
      description: SEARCH_DESCRIPTION,
      inputSchema: WebSearchInputSchema,
      execute: async (input) => {
        const config = configOf(toolCtx)
        return runWebSearch(input, clientOf(config), toolCtx.turn, config.search_calls_per_turn)
      },
    }))
    ctx.tools.register(TAVILY_PLUGIN_ID, WEB_EXTRACT_TOOL_ID, toolCtx => tool({
      description: EXTRACT_DESCRIPTION,
      inputSchema: WebExtractInputSchema,
      execute: async (input) => {
        const config = configOf(toolCtx)
        return runWebExtract(input, clientOf(config), toolCtx.turn, config.extract_calls_per_turn)
      },
    }))
  },
}
