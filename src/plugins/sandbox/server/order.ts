import type { ToolContext } from '@/server/plugins/tools'
import type { SandboxToolError } from '../shared'

const CALL_QUEUE_KEY = 'sandbox:call-queue'

/**
 * Runs this turn's changes to the machine one at a time, in the order the model called them. A
 * model sends several calls in one step expecting them to apply in sequence — "mkdir, then write",
 * two edits of one file — and run at once, a read-modify-write edit loses the other's change. Work
 * that should overlap goes to `background`, which returns at once. Keyed in `ToolContext.turn`, so
 * the queue dies with the generation; calls still queued when it is stopped never start.
 */
export function inCallOrder<I, O, R>(runtime: Pick<ToolContext, 'turn' | 'signal'>, run: (input: I, options: O) => Promise<R>): (input: I, options: O) => Promise<R | SandboxToolError> {
  return (input, options) => {
    const previous = (runtime.turn.get(CALL_QUEUE_KEY) as Promise<unknown> | undefined) ?? Promise.resolve()
    const next = (): Promise<R | SandboxToolError> => runtime.signal.aborted
      ? Promise.resolve({ error: 'The generation was stopped before this call ran.' })
      : run(input, options)
    const current = previous.then(next, next)
    runtime.turn.set(CALL_QUEUE_KEY, current.then(() => undefined, () => undefined))
    return current
  }
}
