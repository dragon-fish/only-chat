/**
 * What happened, in enough detail to find where a turn stopped.
 *
 * The provider layer already logs its own request and response; between the two there was nothing,
 * so a turn that produced no output at all left no trace of how far it got. Reading the database
 * afterwards only says it ended with nothing — not whether the request was ever assembled, whether
 * the model answered, or which tool it was waiting on.
 *
 * Sizes, ids and durations only. Prompts, tool arguments and reasoning text never appear here, the
 * same line the provider logger draws: a log that carries the conversation is one nobody can leave
 * switched on.
 */
export interface LifecycleFields {
  conversationId?: number
  messageId?: number
  userId?: number
  projectId?: number | null
  providerId?: number
  modelId?: string
  toolId?: string
  durationMs?: number
  bytes?: number
  tokens?: number
  count?: number
  status?: string
  reason?: string
}

/** Rounded, because a duration printed to fifteen decimal places is a duration nobody reads. */
function tidy(fields: LifecycleFields): LifecycleFields {
  const out: LifecycleFields = { ...fields }
  if (typeof out.durationMs === 'number') out.durationMs = Math.round(out.durationMs)
  return out
}

export function logLifecycle(event: string, fields: LifecycleFields): void {
  try {
    console.info(JSON.stringify({ event: `chat.${event}`, ...tidy(fields) }))
  } catch {
    // Logging must never be the reason a turn fails.
  }
}

/** The size of what was said, without saying it. */
export function partsBytes(parts: unknown): number {
  try {
    return JSON.stringify(parts ?? null)?.length ?? 0
  } catch {
    return 0
  }
}
