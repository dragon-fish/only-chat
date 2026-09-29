import { z } from 'zod'

/**
 * Name/value rows where each row says whether its value is secret, as in HTTP headers. The flag is
 * data, not a rule: a name only suggests the default, and what the person chose is stored with the
 * row, so changing the suggestion later never reinterprets a value already saved.
 */
export const KeyValueEntrySchema = z.object({
  name: z.string().trim().min(1, '有一行缺少名称。').max(128),
  value: z.string().max(8192),
  secret: z.boolean(),
})
export type KeyValueEntry = z.infer<typeof KeyValueEntrySchema>

/**
 * As the settings form sends and receives a row: a secret's `value` is null both ways — the client
 * is never shown it, and sending null back keeps the saved one.
 */
export interface KeyValueEntryView {
  name: string
  value: string | null
  secret: boolean
}

export const MAX_KEY_VALUE_ENTRIES = 32

/** The schema half of a `key_value` config field; the declaration's type makes its secrets secret. */
export function keyValueList() {
  return z.array(KeyValueEntrySchema).max(MAX_KEY_VALUE_ENTRIES).default([])
}

const SENSITIVE_WORDS = ['auth', 'token', 'key', 'secret', 'password', 'cookie', 'session', 'credential']

/** The default for a new row's secret flag; the person can always flip it. */
export function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_WORDS.some(word => lower.includes(word))
}

export const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
