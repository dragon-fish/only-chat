import type { Context } from 'cordis'
import { tool } from 'ai'
import { TAVILY_PLUGIN_ID, WEB_EXTRACT_TOOL_ID, WEB_SEARCH_TOOL_ID } from '@/shared/plugins'
import type { ToolContext } from '@/server/plugins/tools'
import {
  MAX_EXTRACT_URLS, TAVILY_CONFIG_SCHEMA, WebExtractInputSchema, WebSearchInputSchema, type TavilyConfig,
} from '../shared'
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

const SEARCH_DESCRIPTION = [
  'Searches the web and returns titles, URLs and excerpts.',
  'Use when the answer depends on current information (recent news, prices, results, releases), on facts from after the training cutoff, on a niche specialist topic, or when the user asks for a search.',
  'Do not use for stable general knowledge, for small talk, or for anything the context and conversation history already answer.',
  'When the results are wrong, search again with different keywords: add the year, switch language, name the platform. When the budget runs out and nothing was found, tell the user it was not found; do not split the query to get around the limit.',
  'When the excerpts are not enough, pass the 1-3 most relevant URLs to web_extract in a single call rather than one call per URL.',
  TURN_LIMIT_TIP,
].join('\n')

const EXTRACT_DESCRIPTION = [
  `Fetches the body text of up to ${MAX_EXTRACT_URLS} pages as markdown. Slower and more expensive than web_search; use it only when the excerpts fall short.`,
  'The usual path is web_search, then the 1-3 most relevant URLs, passed here in one call.',
  'Use when the search excerpts lack a specific number, step or full explanation, or when the user names an article to read.',
  'Do not use when the excerpts already answer the question, or when the URL came from neither a search result nor the user.',
  'A URL that fails is marked on its own; one failure does not void the rest of the batch.',
  TURN_LIMIT_TIP,
].join('\n')

export const TavilyServerPlugin = {
  name: 'tavily',
  inject: ['tools'] as const,
  apply(ctx: Context) {
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
