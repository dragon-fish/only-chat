/**
 * A foreground command whose container stops mid-run leaves its output stream open with nothing
 * left to end it, and the generation would wait on it for good. Past the command's own limit plus
 * this margin (timeout's 5 s kill grace and the trip back), the call gives up.
 */
export const STALL_MARGIN_MS = 60_000
export const STALLED = Symbol('stalled')

export async function nextBefore<T>(iterator: AsyncIterator<T>, deadline: number): Promise<IteratorResult<T> | typeof STALLED> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<typeof STALLED>((resolve) => { timer = setTimeout(() => resolve(STALLED), Math.max(0, deadline - Date.now())) })
  try {
    return await Promise.race([iterator.next(), stalled])
  } finally {
    clearTimeout(timer)
  }
}
