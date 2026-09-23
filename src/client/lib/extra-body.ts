import { IMAGE_EXTRA_RESERVED_KEYS, ImageExtraBodySchema, type ImageExtraBody } from '@/shared/artifacts'

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

export interface ExtraBodyRow { key: string; value: string }

export function extraBodyRows(body: ImageExtraBody): ExtraBodyRow[] {
  return Object.entries(body).map(([key, value]) => ({ key, value: formatExtraValue(value) }))
}

/**
 * Blank rows are skipped. Anything else that cannot go out as written — a value without a name, a
 * name used twice (the later row would silently win), a reserved name — is an error, never dropped.
 */
export function buildExtraBody(rows: readonly ExtraBodyRow[]): { body: ImageExtraBody } | { error: string } {
  const entries: Array<[string, unknown]> = []
  for (const row of rows) {
    const key = row.key.trim()
    if (!key && !row.value.trim()) continue
    if (!key) return { error: '有参数缺少名称。' }
    if (IMAGE_EXTRA_RESERVED_KEYS.includes(key)) return { error: `${key} 由应用自动设置，不能在这里填写。` }
    if (entries.some(([existing]) => existing === key)) return { error: `参数 ${key} 重复了。` }
    entries.push([key, parseExtraValue(row.value)])
  }
  const parsed = ImageExtraBodySchema.safeParse(Object.fromEntries(entries))
  return parsed.success ? { body: parsed.data } : { error: parsed.error.issues[0]?.message ?? '参数无效。' }
}
