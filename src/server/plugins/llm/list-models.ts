import type { ProviderInterface } from '@/shared/models'

/** GET {base_url}/models. The AI SDK has no listing API, so we call the endpoint directly. */
export async function listRemoteModels(
  provider: Pick<ProviderInterface, 'protocol' | 'base_url'>,
  apiKey: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  // Neither Vertex shape exposes an OpenAI-style catalogue under its own Base URL; a compatible
  // gateway keeps its listing on a separate base that we must not guess at.
  if (provider.protocol === 'vertex-compatible') {
    throw new Error(`model listing is not supported for ${provider.protocol}`)
  }
  const url = `${provider.base_url.replace(/\/$/, '')}/models`
  const headers: Record<string, string> = provider.protocol === 'anthropic'
    ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey ?? ''}` }
  const res = await fetchFn(url, { headers })
  if (!res.ok) throw new Error(`model listing failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((m) => m.id).sort()
}
