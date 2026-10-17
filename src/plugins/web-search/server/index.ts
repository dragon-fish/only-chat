import type { Context } from 'cordis'
import { tool, type Tool } from 'ai'
import { WEB_EXTRACT_TOOL_ID, WEB_SEARCH_PLUGIN_ID, WEB_SEARCH_TOOL_ID } from '@/shared/plugins'
import type { ToolContext } from '@/server/plugins/tools'
import type { PluginConfig } from '@/server/plugins/plugin-config'
import {
  DEEPSEEK_MAX_RESULTS, DeepSeekSearchInputSchema, MAX_EXTRACT_URLS, TavilySearchInputSchema, WEB_SEARCH_CONFIG_SCHEMA,
  WebExtractInputSchema, type WebSearchConfig,
} from '../shared'
import { whileOffered } from '@/server/plugins/prompt-sections'
import manifest from '../manifest'
import { DeepSeekClient } from './deepseek'
import { TavilyClient } from './tavily'
import { runWebExtract, runWebSearch } from './runners'

/** Each tool reads the one configuration the registry already parsed. */
function configOf(ctx: ToolContext): WebSearchConfig {
  return WEB_SEARCH_CONFIG_SCHEMA.parse(ctx.config)
}

function tavilyOf(config: WebSearchConfig): TavilyClient {
  return new TavilyClient({ apiKey: config.tavily_api_key ?? '', searchDepth: config.tavily_search_depth })
}

/** A chosen provider lends its key as it is now, not as it was when it was chosen. */
async function deepseekOf(pluginConfig: PluginConfig, toolCtx: ToolContext, config: WebSearchConfig): Promise<DeepSeekClient> {
  if (config.deepseek_provider_id === null) return new DeepSeekClient({ apiKey: config.deepseek_api_key ?? '' })
  const { apiKey, headers } = await pluginConfig.providerCredentials(
    toolCtx.userId, WEB_SEARCH_PLUGIN_ID, 'deepseek_provider_id', config.deepseek_provider_id,
  )
  return new DeepSeekClient({ apiKey, headers })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

const TAVILY_SEARCH_DESCRIPTION = [
  'Searches the web and returns titles, URLs and excerpts.',
  TURN_LIMIT_TIP,
].join('\n')

const DEEPSEEK_SEARCH_DESCRIPTION = [
  `Searches the web and returns up to ${DEEPSEEK_MAX_RESULTS} results, each with its title, URL, several relevant passages, and where known the publication date, site name and an authority rating.`,
  'Narrow with the query operators rather than by searching repeatedly; check dates before treating a result as current.',
  TURN_LIMIT_TIP,
].join('\n')

const EXTRACT_DESCRIPTION = [
  `Fetches the body text of up to ${MAX_EXTRACT_URLS} pages as markdown. Slower and more expensive than web_search.`,
  'Pass only URLs that came from a search result or from the user.',
  'A URL that fails is marked on its own; one failure does not void the rest of the batch.',
  TURN_LIMIT_TIP,
].join('\n')

/**
 * The tool ids stay the same whichever backend is live, so a conversation keeps its selection and
 * its history across a switch; what changes is the arguments each accepts and what it returns.
 */
function searchTool(pluginConfig: PluginConfig, toolCtx: ToolContext): Tool {
  const config = configOf(toolCtx)
  const cap = config.search_calls_per_turn
  if (config.backend === 'tavily') {
    return tool({
      description: TAVILY_SEARCH_DESCRIPTION,
      inputSchema: TavilySearchInputSchema,
      execute: input => runWebSearch(input, tavilyOf(config), toolCtx.turn, cap),
    })
  }
  return tool({
    description: DEEPSEEK_SEARCH_DESCRIPTION,
    inputSchema: DeepSeekSearchInputSchema,
    execute: async (input) => {
      try {
        return await runWebSearch(input, await deepseekOf(pluginConfig, toolCtx, config), toolCtx.turn, cap)
      } catch (error) {
        return { error: `web_search failed: ${message(error)}` }
      }
    },
  })
}

function extractTool(pluginConfig: PluginConfig, toolCtx: ToolContext): Tool {
  const config = configOf(toolCtx)
  const cap = config.extract_calls_per_turn
  return tool({
    description: EXTRACT_DESCRIPTION,
    inputSchema: WebExtractInputSchema,
    execute: async (input) => {
      try {
        const client = config.backend === 'tavily' ? tavilyOf(config) : await deepseekOf(pluginConfig, toolCtx, config)
        return await runWebExtract(input, client, toolCtx.turn, cap)
      } catch (error) {
        return { error: `web_extract failed: ${message(error)}` }
      }
    },
  })
}

export const WebSearchServerPlugin = {
  name: 'web-search',
  inject: ['tools', 'promptSections', 'pluginConfig'] as const,
  apply(ctx: Context) {
    ctx.promptSections.register(WEB_SEARCH_PLUGIN_ID, whileOffered(manifest, GUIDANCE))
    ctx.tools.register(WEB_SEARCH_PLUGIN_ID, WEB_SEARCH_TOOL_ID, toolCtx => searchTool(ctx.pluginConfig, toolCtx))
    ctx.tools.register(WEB_SEARCH_PLUGIN_ID, WEB_EXTRACT_TOOL_ID, toolCtx => extractTool(ctx.pluginConfig, toolCtx))
  },
}
