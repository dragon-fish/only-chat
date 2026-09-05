import type { ProviderRow } from '../../db/schema'

/** GET {base_url}/models. The AI SDK has no listing API, so we call the endpoint directly. */
export async function listRemoteModels(
  provider: ProviderRow,
  apiKey: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  if (provider.protocol === 'vertex') throw new Error('model listing is not supported for vertex')
  const url = `${provider.base_url.replace(/\/$/, '')}/models`
  const headers: Record<string, string> = provider.protocol === 'anthropic'
    ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey ?? ''}` }
  const res = await fetchFn(url, { headers })
  if (!res.ok) throw new Error(`model listing failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((m) => m.id).sort()
}
