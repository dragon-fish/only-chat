import { z } from 'zod'
import type { KeyValueEntry, KeyValueEntryView } from '@/shared/key-value'
import { decryptSecret, encryptSecret } from './crypto'

/** As stored: a secret row's value becomes ciphertext, a plain row is kept as typed. */
export function sealEntries(secret: string, entries: readonly KeyValueEntry[]): Promise<KeyValueEntry[]> {
  return Promise.all(entries.map(async entry => (entry.secret ? { ...entry, value: await encryptSecret(secret, entry.value) } : entry)))
}

export function openEntries(secret: string, entries: readonly KeyValueEntry[]): Promise<KeyValueEntry[]> {
  return Promise.all(entries.map(async entry => (entry.secret ? { ...entry, value: await decryptSecret(secret, entry.value) } : entry)))
}

/** What the settings form is shown: a secret row's value never leaves the server. */
export function entriesView(entries: readonly KeyValueEntry[]): KeyValueEntryView[] {
  return entries.map(entry => ({ name: entry.name, value: entry.secret ? null : entry.value, secret: entry.secret }))
}

/**
 * The form never received a saved secret's value, so it sends null to mean "unchanged". A row keeps
 * its saved value only under the same name and only while still secret; anything else has to be
 * typed again rather than silently moving a credential to a different header.
 */
export function keepSavedSecrets(rows: readonly KeyValueEntryView[], saved: readonly KeyValueEntry[] | undefined): KeyValueEntry[] {
  return rows.map((row) => {
    if (row.value !== null) return { name: row.name, value: row.value, secret: row.secret }
    const previous = row.secret ? saved?.find(entry => entry.secret && entry.name === row.name) : undefined
    // A ZodError, so the route reports it the way it reports every other invalid field.
    if (!previous) throw new z.ZodError([{ code: 'custom', message: `请填写 ${row.name} 的值`, path: [row.name], input: row }])
    return { name: row.name, value: previous.value, secret: true }
  })
}
