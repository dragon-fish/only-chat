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

const SEARCH_DESCRIPTION = [
  '联网搜索，返回标题、URL 与摘要片段。',
  '何时调：时效信息（最近的新闻、价格、赛事、版本）、训练截止之后的事实、小众专业话题、用户明确要求搜索。',
  '何时别调：稳定的事实性常识、闲聊、上下文或对话历史已经能回答的问题。',
  '结果不对就换关键词重搜（加年份、换语言、换平台名）。用完本轮次数仍未找到，就告诉用户没查到，不要拆分 query 绕开限制。',
  '本工具存在单轮调用次数限制，剩余次数见每次调用结果，据此安排，不要靠撞上限才发现用完。',
  '摘要不够时，挑 1-3 个最相关的 URL 一次性传给 web_extract，不要每个 URL 单独调。',
].join('\n')

const EXTRACT_DESCRIPTION = [
  `抓取 ${MAX_EXTRACT_URLS} 个以内网页的正文（markdown）。比 web_search 更慢更贵，只在摘要不足时用。`,
  '典型流程：web_search → 挑 1-3 个最相关 URL → 一次性传给本工具。',
  '何时调：搜索摘要缺少具体数字、步骤或完整说明，或用户明确要求读某篇文章。',
  '何时别调：摘要已经够回答、URL 来源不可信（既非搜索结果也非用户提供）。',
  '单个 URL 失败会被单独标注，不要因为一个失败就放弃整批。',
  '本工具存在单轮调用次数限制，剩余次数见每次调用结果，据此安排，不要靠撞上限才发现用完。',
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
