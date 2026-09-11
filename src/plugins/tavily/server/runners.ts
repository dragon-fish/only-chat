import {
  DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS,
  type ToolError, type WebExtractClient, type WebExtractInput, type WebExtractOutput,
  type WebSearchClient, type WebSearchInput, type WebSearchOutput,
} from '../shared'

const SEARCH_CALLS = 'tavily.search.calls'
const EXTRACT_CALLS = 'tavily.extract.calls'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The per-turn budget exists to stop a loop, not to save money: an agent that has searched its
 * allowance without finding the answer is searching for the wrong thing and should come back to the
 * human. The refusal therefore states the count and nothing else — an explanation of the rule is
 * one more thing for the model to argue with.
 *
 * Counting happens before the call, so a network failure or an empty result still spends its turn.
 * Malformed input never reaches here: the AI SDK validates against the tool's inputSchema first.
 */
function spend(turn: Map<string, unknown>, key: string, cap: number): number | null {
  const used = (turn.get(key) as number | undefined) ?? 0
  if (used >= cap) return null
  turn.set(key, used + 1)
  return used + 1
}

export async function runWebSearch(
  input: WebSearchInput,
  client: WebSearchClient,
  turn: Map<string, unknown>,
  cap: number,
): Promise<WebSearchOutput | ToolError> {
  if (spend(turn, SEARCH_CALLS, cap) === null) {
    return { error: `web_search 本轮已调用 ${cap} 次，已达上限。` }
  }
  const maxResults = Math.min(Math.max(input.max_results ?? DEFAULT_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS)
  try {
    return { query: input.query, results: await client.search({ query: input.query, maxResults }) }
  } catch (error) {
    return { error: `web_search 失败：${message(error)}` }
  }
}

export async function runWebExtract(
  input: WebExtractInput,
  client: WebExtractClient,
  turn: Map<string, unknown>,
  cap: number,
): Promise<WebExtractOutput | ToolError> {
  if (spend(turn, EXTRACT_CALLS, cap) === null) {
    return { error: `web_extract 本轮已调用 ${cap} 次，已达上限。` }
  }
  try {
    return await client.extract(input.urls)
  } catch (error) {
    return { error: `web_extract 失败：${message(error)}` }
  }
}
