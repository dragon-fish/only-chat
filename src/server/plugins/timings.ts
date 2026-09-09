/** Stage timings for slow multi-step operations. Records durations and counts only, never payloads. */
export function elapsed() {
  const start = Date.now()
  let previous = start
  const stages: Record<string, unknown> = {}
  return {
    mark(name: string, counts: Record<string, number> = {}) {
      const now = Date.now()
      stages[`${name}_ms`] = now - previous
      previous = now
      for (const [key, value] of Object.entries(counts)) stages[`${name}_${key}`] = value
    },
    report() {
      return { total_ms: Date.now() - start, ...stages }
    },
  }
}
