import {
  DEEPSEEK_API_HOST, DEFAULT_SEARCH_RESULTS,
  type DeepSeekSearchInput, type WebExtractClient, type WebExtractOutput, type WebSearchClient, type WebSearchResult,
} from '../shared'

const BASE_URL = `https://${DEEPSEEK_API_HOST}/v1/tools`

interface DeepSeekSearchWire {
  results?: {
    title?: string
    url?: string
    snippet?: string
    summary?: string
    content?: string
    site_name?: string
    site_icon?: string
    date?: string
    authority?: number
    rerank_score?: number
  }[]
}

interface DeepSeekFetchWire {
  title?: string
  content?: string
}

/** What each documented status means, so the model can tell a retry from a dead end. */
const STATUS_REASONS: Record<number, string> = {
  400: 'invalid request',
  401: 'API key rejected',
  402: 'account balance exhausted',
  403: 'rejected by the security check',
  404: 'content unavailable',
  408: 'timed out, retryable',
  429: 'rate limited, retryable',
}

export class DeepSeekRequestError extends Error {
  constructor(endpoint: string, readonly status: number) {
    const reason = STATUS_REASONS[status] ?? (status >= 500 ? 'server error, retryable' : 'request failed')
    // The body may quote the request back; surface the status only so a key cannot reach a log.
    super(`DeepSeek ${endpoint}: ${reason} (HTTP ${status})`)
  }
}

/**
 * Fetch escapes every ASCII punctuation mark in the page (`\#\# https\:\/\/api\.deepseek\.com`) and
 * keeps no code fences or links for an escape to protect. Undoing it is what a markdown renderer
 * would do, and spares the model a backslash on every other character.
 */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

export interface DeepSeekClientOptions {
  apiKey: string
  /** A provider's custom headers, sent beside its key. */
  headers?: Record<string, string>
}

/**
 * DeepSeek's Search and Fetch APIs. They are billed to, and authenticated by, the same account as
 * its chat models, which is why a saved DeepSeek provider can lend its key.
 */
export class DeepSeekClient implements WebSearchClient<DeepSeekSearchInput>, WebExtractClient {
  constructor(private readonly options: DeepSeekClientOptions) {
    if (!options.apiKey) throw new Error('DeepSeekClient: apiKey is required')
  }

  private async _post<T>(endpoint: 'search' | 'fetch', body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers: { ...this.options.headers, 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new DeepSeekRequestError(endpoint, response.status)
    return await response.json() as T
  }

  async search(input: DeepSeekSearchInput): Promise<WebSearchResult[]> {
    const wire = await this._post<DeepSeekSearchWire>('search', {
      query: input.query,
      count: input.max_results ?? DEFAULT_SEARCH_RESULTS,
      ...(input.question ? { ori_question: input.question } : {}),
      ...(input.full_text ? { need_content: true } : {}),
    })
    return (wire.results ?? []).map(result => ({
      title: result.title ?? '',
      url: result.url ?? '',
      // The summary is several relevant passages; the snippet is the first lines of one of them.
      content: result.summary || result.snippet || '',
      ...(typeof result.rerank_score === 'number' ? { score: result.rerank_score } : {}),
      ...(result.date ? { date: result.date } : {}),
      ...(result.site_name ? { site_name: result.site_name } : {}),
      ...(result.site_icon ? { site_icon: result.site_icon } : {}),
      ...(typeof result.authority === 'number' ? { authority: result.authority } : {}),
      ...(result.content ? { full_text: unescapeMarkdown(result.content) } : {}),
    }))
  }

  /**
   * One request per URL — the API takes one — run together. The tool caps a batch below DeepSeek's
   * 5 QPS account limit, so a batch never throttles itself.
   */
  async extract(urls: string[]): Promise<Omit<WebExtractOutput, 'note'>> {
    const settled = await Promise.allSettled(urls.map(url => this._post<DeepSeekFetchWire>('fetch', { url })))
    const out: Omit<WebExtractOutput, 'note'> = { results: [], failed: [] }
    settled.forEach((outcome, index) => {
      const url = urls[index]!
      if (outcome.status === 'rejected') {
        out.failed.push({ url, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) })
        return
      }
      out.results.push({
        url,
        ...(outcome.value.title ? { title: outcome.value.title } : {}),
        content: unescapeMarkdown(outcome.value.content ?? ''),
      })
    })
    return out
  }
}
