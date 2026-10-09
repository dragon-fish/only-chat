import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { ProviderRow } from '../../db/schema'
import { decryptSecret } from './crypto'
import { openEntries } from './key-value-secrets'

/** Everything a provider authenticates with: its key and the custom headers sent beside it. */
export interface ProviderCredentials {
  apiKey: string
  headers: Record<string, string>
}

export async function providerHeaders(secret: string, provider: Pick<ProviderRow, 'headers'>): Promise<Record<string, string>> {
  return Object.fromEntries((await openEntries(secret, provider.headers)).map(entry => [entry.name, entry.value]))
}

/** Null when the provider has no key stored. */
export async function providerCredentials(secret: string, provider: Pick<ProviderRow, 'api_key' | 'headers'>): Promise<ProviderCredentials | null> {
  if (!provider.api_key) return null
  return { apiKey: await decryptSecret(secret, provider.api_key), headers: await providerHeaders(secret, provider) }
}

/**
 * Adds the provider's custom headers to requests bound for `baseURL`'s origin only. They are a
 * credential like the API key: a URL elsewhere — a CDN link in a response, a file the SDK downloads
 * — must never receive them.
 */
export function withHeaders(headers: Record<string, string>, baseURL: string, upstream?: FetchFunction): FetchFunction {
  const origin = new URL(baseURL).origin
  return (input, init) => {
    const next = upstream ?? globalThis.fetch
    const url = input instanceof Request ? input.url : String(input)
    if (new URL(url).origin !== origin || Object.keys(headers).length === 0) return next(input, init)
    const merged = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => merged.set(name, value))
    for (const [name, value] of Object.entries(headers)) merged.set(name, value)
    return next(input, { ...init, headers: merged })
  }
}
