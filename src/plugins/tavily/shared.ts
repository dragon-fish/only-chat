import { z } from 'zod'

export const MAX_SEARCH_RESULTS = 10
export const DEFAULT_SEARCH_RESULTS = 5
export const MAX_EXTRACT_URLS = 5

export const WebSearchInputSchema = z.object({
  query: z.string().trim().min(1).describe('搜索关键词或自然语言查询，中英文均可'),
  max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional()
    .describe(`返回结果条数，1-${MAX_SEARCH_RESULTS}，默认 ${DEFAULT_SEARCH_RESULTS}`),
})

export const WebExtractInputSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(MAX_EXTRACT_URLS)
    .describe(`要抓取的网页 URL 列表（1-${MAX_EXTRACT_URLS} 个，推荐 1-3）`),
})

export const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number().optional(),
})

export const WebSearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(WebSearchResultSchema),
})

export const WebExtractOutputSchema = z.object({
  results: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
    content: z.string(),
  })),
  failed: z.array(z.object({ url: z.string(), error: z.string() })),
})

/** Both tools report a refusal this way rather than throwing: one bad call must not end the turn. */
export const ToolErrorSchema = z.object({ error: z.string() })

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>
export type WebExtractInput = z.infer<typeof WebExtractInputSchema>
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>
export type WebExtractOutput = z.infer<typeof WebExtractOutputSchema>
export type ToolError = z.infer<typeof ToolErrorSchema>

/**
 * Backend-agnostic search interfaces. The runners depend only on these, which keeps them testable
 * with no API key and makes replacing Tavily a one-file change.
 */
export interface WebSearchClient {
  search(input: { query: string; maxResults: number }): Promise<WebSearchOutput['results']>
}

export interface WebExtractClient {
  extract(urls: string[]): Promise<WebExtractOutput>
}

export const TAVILY_CONFIG_SCHEMA = z.object({
  api_key: z.string().trim().min(1, '请填写 Tavily API Key'),
  search_depth: z.enum(['basic', 'advanced']).default('basic'),
  search_calls_per_turn: z.number().int().min(1).max(10).default(3),
  extract_calls_per_turn: z.number().int().min(1).max(10).default(2),
})

export type TavilyConfig = z.infer<typeof TAVILY_CONFIG_SCHEMA>
