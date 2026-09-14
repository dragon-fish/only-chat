import type { CurrentTimeInput, CurrentTimeOutput } from '../shared'

/**
 * Pure but for the clock, which is injected so a test is not at the mercy of when it runs.
 * Costs nothing and touches no network — the point of this tool is to be the one an agent can call
 * as often as it likes, including several at once, without spending anything.
 */
export function runCurrentTime(
  input: CurrentTimeInput,
  now: Date = new Date(),
): CurrentTimeOutput | { error: string } {
  const timezone = input.timezone?.trim() || 'UTC'
  let local: string
  let weekday: string
  try {
    local = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'medium',
    }).format(now)
    weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'long' }).format(now)
  } catch {
    // Intl is the only authority on what a zone name means; never keep a list of our own to drift.
    return { error: `Unknown timezone: ${timezone}. Use an IANA name such as Asia/Shanghai.` }
  }
  return { timezone, iso: now.toISOString(), local, weekday }
}
