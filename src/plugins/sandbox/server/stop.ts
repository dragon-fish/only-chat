export const STOPPED = Symbol('stopped')

/**
 * Settles with `work`, or with `STOPPED` as soon as the turn is stopped. A call to a machine that
 * is still starting is held until it is up — minutes, on a cold start — and a stopped turn must not
 * wait for that. `work` runs on regardless; stopping what it started is the caller's kill.
 */
export function untilStopped<T>(signal: AbortSignal, work: Promise<T>): Promise<T | typeof STOPPED> {
  if (signal.aborted) {
    work.catch(() => {})
    return Promise.resolve(STOPPED)
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {})
      resolve(STOPPED)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
