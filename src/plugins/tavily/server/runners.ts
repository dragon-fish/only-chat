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
 * Names the reset condition rather than saying "this turn": an agent reading 「本轮」 cannot tell
 * whether that means this reply or the whole conversation, and guesses the expensive way.
 */
const RESET_CLAUSE = 'the budget resets after the user speaks again'

/**
 * Rides along with every success so the agent plans against the budget instead of hitting it, and
 * never in the vocabulary of failure: eight search hits delivered alongside the word 「耗尽」 read
 * as an error the agent then has to reconcile. The reset clause appears only once the budget is
 * actually gone, which is the only time it is actionable.
 */
function budgetNote(tool: string, left: number, cap: number): string {
  const remaining = `${tool} has ${left}/${cap} calls left`
  return left > 0 ? `${remaining}。` : `${remaining}，${RESET_CLAUSE}。`
}

/** Attached to a call that was turned away — the one place "exhausted" describes what just happened. */
function budgetRefusal(tool: string, cap: number): string {
  return `${tool} is out of calls (0/${cap}); ${RESET_CLAUSE}.`
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
    return { refused: budgetRefusal('web_search', cap) }
  }
  const maxResults = Math.min(Math.max(input.max_results ?? DEFAULT_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS)
  try {
    const results = await client.search({ query: input.query, maxResults })
    return { query: input.query, results, note: budgetNote('web_search', callsLeft, cap) }
  } catch (error) {
    return { error: `web_search failed: ${message(error)}` }
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
    return { refused: budgetRefusal('web_extract', cap) }
  }
  try {
    return { ...await client.extract(input.urls), note: budgetNote('web_extract', callsLeft, cap) }
  } catch (error) {
    return { error: `web_extract failed: ${message(error)}` }
  }
}
