import { z } from 'zod'

export const DEFAULT_SEARCH_RESULTS = 5
export const TAVILY_MAX_RESULTS = 10
export const DEEPSEEK_MAX_RESULTS = 50
/** DeepSeek's own bound, on both `query` and `ori_question`. */
export const DEEPSEEK_QUERY_MAX_LENGTH = 128
export const MAX_EXTRACT_URLS = 5

/** Exactly one is live at a time; each offers the same two tools in its own shape. */
export const WEB_SEARCH_BACKENDS = ['deepseek', 'tavily'] as const
export type WebSearchBackend = typeof WEB_SEARCH_BACKENDS[number]

export const DEEPSEEK_API_HOST = 'api.deepseek.com'

export const TavilySearchInputSchema = z.object({
  query: z.string().trim().min(1).describe('Search keywords or a natural-language query, in any language.'),
  max_results: z.number().int().min(1).max(TAVILY_MAX_RESULTS).optional()
    .describe(`How many results to return, 1-${TAVILY_MAX_RESULTS}. Defaults to ${DEFAULT_SEARCH_RESULTS}.`),
})

export const DeepSeekSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(DEEPSEEK_QUERY_MAX_LENGTH).describe([
    `Search keywords, at most ${DEEPSEEK_QUERY_MAX_LENGTH} characters, in any language. Operators:`,
    'site:example.com / -site:example.com keep or drop a domain; "exact phrase"; -word or -"phrase" exclude;',
    'lang:en picks the result language; after:YYYY-MM-DD / before:YYYY-MM-DD bound the publication date.',
  ].join(' ')),
  max_results: z.number().int().min(1).max(DEEPSEEK_MAX_RESULTS).optional()
    .describe(`How many results to return, 1-${DEEPSEEK_MAX_RESULTS}. Defaults to ${DEFAULT_SEARCH_RESULTS}.`),
  question: z.string().trim().min(1).max(DEEPSEEK_QUERY_MAX_LENGTH).optional()
    .describe('The question the search serves, in one sentence, when it says more than the keywords do. Used to rank results.'),
  full_text: z.boolean().optional()
    .describe('Also return each page\'s full text. Large: pair it with a small max_results. Use it instead of a follow-up web_extract when you already know you will read the pages.'),
})

/** What a card needs from either backend's arguments. */
export const WebSearchQuerySchema = z.object({ query: z.string() })

export const WebExtractInputSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(MAX_EXTRACT_URLS)
    .describe(`The page URLs to fetch, 1-${MAX_EXTRACT_URLS} of them. Three or fewer is usual.`),
})

/**
 * Every field any backend reports, each optional beyond the three all of them have. A backend fills
 * what it knows; flattening DeepSeek's richer results down to Tavily's would throw away the date and
 * source that decide whether a hit is current enough to trust.
 */
export const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  /** The relevant excerpt. DeepSeek's runs to several paragraphs; Tavily's to a few sentences. */
  content: z.string(),
  score: z.number().optional(),
  /** Publication date as the backend reports it, ISO 8601. */
  date: z.string().optional(),
  site_name: z.string().optional(),
  /**
   * For the card, yet the model reads it too: a stored result is replayed to later turns as it was
   * saved, so trimming it only in the turn that made it would change history under the prompt cache.
   */
  site_icon: z.string().optional(),
  /** DeepSeek's rating of the source's authority. */
  authority: z.number().optional(),
  /** The whole page as markdown, when the search asked for it. */
  full_text: z.string().optional(),
})

export const WebSearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(WebSearchResultSchema),
  /**
   * A self-describing sentence — "本工具本轮还能使用 2 次。" — rather than a bare number with its
   * meaning explained in the tool description. Tool descriptions sit in the cached prompt prefix,
   * so editing one invalidates the prompt cache of every conversation; a result travels in the
   * appended body and costs nothing. Optional so results persisted before this field still parse.
   */
  note: z.string().optional(),
})

export const WebExtractOutputSchema = z.object({
  results: z.array(z.object({
    url: z.string(),
    title: z.string().optional(),
    content: z.string(),
  })),
  failed: z.array(z.object({ url: z.string(), error: z.string() })),
  /** See WebSearchOutputSchema.note. */
  note: z.string().optional(),
})

/** A real failure — the network, the API, a bad key. Something went wrong. */
export const ToolErrorSchema = z.object({ error: z.string() })

/**
 * The per-turn budget stopping a call. Deliberately NOT an error: nothing went wrong, the tool is
 * telling the model to stop searching and talk to the human. The UI must not dress it in red.
 */
export const ToolRefusalSchema = z.object({ refused: z.string() })

export type TavilySearchInput = z.infer<typeof TavilySearchInputSchema>
export type DeepSeekSearchInput = z.infer<typeof DeepSeekSearchInputSchema>
export type WebExtractInput = z.infer<typeof WebExtractInputSchema>
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>
export type WebExtractOutput = z.infer<typeof WebExtractOutputSchema>
export type ToolError = z.infer<typeof ToolErrorSchema>
export type ToolRefusal = z.infer<typeof ToolRefusalSchema>

/**
 * The seam between the runners and a backend. Each backend searches with its own arguments; the
 * runners only need the query, and stay testable with no API key.
 */
export interface WebSearchClient<Input extends { query: string }> {
  search(input: Input): Promise<WebSearchResult[]>
}

export interface WebExtractClient {
  extract(urls: string[]): Promise<Omit<WebExtractOutput, 'note'>>
}

export const WEB_SEARCH_CONFIG_SCHEMA = z.object({
  backend: z.enum(WEB_SEARCH_BACKENDS).default('deepseek'),
  /** Null means the key below; a provider's own key is read afresh on every call. */
  deepseek_provider_id: z.number().int().positive().nullable().default(null),
  deepseek_api_key: z.string().trim().min(1).optional(),
  tavily_api_key: z.string().trim().min(1).optional(),
  tavily_search_depth: z.enum(['basic', 'advanced']).default('basic'),
  search_calls_per_turn: z.number().int().min(1).max(10).default(3),
  extract_calls_per_turn: z.number().int().min(1).max(10).default(2),
}).superRefine((config, ctx) => {
  // Only the live backend's credential is required: switching away keeps the other one stored.
  if (config.backend === 'tavily' && !config.tavily_api_key) {
    ctx.addIssue({ code: 'custom', path: ['tavily_api_key'], message: '请填写 Tavily API Key' })
  }
  if (config.backend === 'deepseek' && config.deepseek_provider_id === null && !config.deepseek_api_key) {
    ctx.addIssue({ code: 'custom', path: ['deepseek_api_key'], message: '请选择 DeepSeek 供应商或填写 API Key' })
  }
})

export type WebSearchConfig = z.infer<typeof WEB_SEARCH_CONFIG_SCHEMA>
