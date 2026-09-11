import type { WebExtractClient, WebExtractOutput, WebSearchClient, WebSearchOutput } from '../shared'

const BASE_URL = 'https://api.tavily.com'

interface TavilySearchWire {
  results?: { title?: string; url?: string; content?: string; score?: number }[]
}

interface TavilyExtractWire {
  results?: { url?: string; title?: string; raw_content?: string }[]
  failed_results?: { url?: string; error?: string }[]
}

export interface TavilyClientOptions {
  apiKey: string
  searchDepth: 'basic' | 'advanced'
}

/**
 * Plain `fetch` rather than `@tavily/core`: that SDK pulls in axios and https-proxy-agent, which
 * need node's net/http and do not run on Workers. Two endpoints do not justify the dependency.
 */
export class TavilyClient implements WebSearchClient, WebExtractClient {
  constructor(private readonly options: TavilyClientOptions) {
    if (!options.apiKey) throw new Error('TavilyClient: apiKey is required')
  }

  private async _post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(body),
    })
    // The body may quote the request back; surface the status only so a key cannot reach a log.
    if (!response.ok) throw new Error(`Tavily ${endpoint} 请求失败（HTTP ${response.status}）`)
    return await response.json() as T
  }

  async search(input: { query: string; maxResults: number }): Promise<WebSearchOutput['results']> {
    const wire = await this._post<TavilySearchWire>('search', {
      query: input.query,
      search_depth: this.options.searchDepth,
      max_results: input.maxResults,
      // This product has its own model; Tavily's synthesized answer is a second wait for nothing.
      include_answer: false,
    })
    return (wire.results ?? []).map(result => ({
      title: result.title ?? '',
      url: result.url ?? '',
      content: result.content ?? '',
      ...(typeof result.score === 'number' ? { score: result.score } : {}),
    }))
  }

  async extract(urls: string[]): Promise<WebExtractOutput> {
    const wire = await this._post<TavilyExtractWire>('extract', {
      urls,
      extract_depth: 'basic',
      format: 'markdown',
    })
    return {
      results: (wire.results ?? []).map(result => ({
        url: result.url ?? '',
        ...(result.title ? { title: result.title } : {}),
        content: result.raw_content ?? '',
      })),
      failed: (wire.failed_results ?? []).map(failure => ({
        url: failure.url ?? '',
        error: failure.error ?? 'unknown error',
      })),
    }
  }
}
