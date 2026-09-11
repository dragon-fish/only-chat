import {
  DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS,
  type ToolError, type ToolRefusal, type WebExtractClient, type WebExtractInput, type WebExtractOutput,
  type WebSearchClient, type WebSearchInput, type WebSearchOutput,
} from '../shared'

const SEARCH_CALLS = 'tavily.search.calls'
const EXTRACT_CALLS = 'tavily.extract.calls'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Rides along with every success so the agent plans against the budget instead of hitting it.
 * States the reset condition rather than saying "this turn": an agent reading "本轮" has no way to
 * tell whether that means this reply or the whole conversation, and guesses the expensive way.
 */
function budgetNote(tool: string, left: number): string {
  return `${tool} 还能使用 ${left} 次，额度在用户下次发言后重置。`
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
  return cap - used - 1
}

export async function runWebSearch(
  input: WebSearchInput,
  client: WebSearchClient,
  turn: Map<string, unknown>,
  cap: number,
): Promise<WebSearchOutput | ToolError | ToolRefusal> {
  const callsLeft = spend(turn, SEARCH_CALLS, cap)
  if (callsLeft === null) {
    return { refused: `web_search 调用次数已用完（上限 ${cap} 次），额度在用户下次发言后重置。` }
  }
  const maxResults = Math.min(Math.max(input.max_results ?? DEFAULT_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS)
  try {
    const results = await client.search({ query: input.query, maxResults })
    return { query: input.query, results, note: budgetNote('web_search', callsLeft) }
  } catch (error) {
    return { error: `web_search 失败：${message(error)}` }
  }
}

export async function runWebExtract(
  input: WebExtractInput,
  client: WebExtractClient,
  turn: Map<string, unknown>,
  cap: number,
): Promise<WebExtractOutput | ToolError | ToolRefusal> {
  const callsLeft = spend(turn, EXTRACT_CALLS, cap)
  if (callsLeft === null) {
    return { refused: `web_extract 调用次数已用完（上限 ${cap} 次），额度在用户下次发言后重置。` }
  }
  try {
    return { ...await client.extract(input.urls), note: budgetNote('web_extract', callsLeft) }
  } catch (error) {
    return { error: `web_extract 失败：${message(error)}` }
  }
}
