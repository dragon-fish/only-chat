/**
 * Extra body values are typed as text: whatever parses as JSON is JSON (`false`, `12`, `{"a":1}`),
 * anything else is a string. A string that would itself parse as JSON is written quoted so it reads
 * back as a string — `"12"`, not `12`.
 */
export function parseExtraValue(text: string): unknown {
  try { return JSON.parse(text) }
  catch { return text }
}

export function formatExtraValue(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value)
  try { JSON.parse(value) }
  catch { return value }
  return JSON.stringify(value)
}
