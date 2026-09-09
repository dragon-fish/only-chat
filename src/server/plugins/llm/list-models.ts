import type { ProviderInterface } from '@/shared/models'
import { ModelModalitySchema, type ModelMetadata, type ModelModality } from '@/shared/model-metadata'

export interface RemoteModel {
  id: string
  metadata: ModelMetadata
  providerMetadata: Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function modalities(value: unknown): ModelModality[] {
  const list = Array.isArray(value) ? value.flatMap(item => ModelModalitySchema.safeParse(item).success ? [item] : []) : []
  return list as ModelModality[]
}

function normalize(raw: Record<string, unknown>): RemoteModel | null {
  if (typeof raw.id !== 'string' || !raw.id) return null
  const nested = object(raw.modalities)
  const input = modalities(nested?.input_modalities ?? raw.input_modalities)
  const output = modalities(nested?.output_modalities ?? raw.output_modalities)
  const tasks = Array.isArray(raw.task_type) ? raw.task_type : []
  if (tasks.includes('ImageToImage') && !input.includes('image')) input.push('image')
  if ((tasks.includes('TextToImage') || raw.domain === 'ImageGeneration') && !output.includes('image')) output.push('image')
  const capabilities = object(raw.capabilities)
  const metadata: ModelMetadata = {
    ...(typeof raw.display_name === 'string' ? { name: raw.display_name } : typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(input.length || output.length ? { modalities: { input: input.length ? input : ['text'], output: output.length ? output : ['text'] } } : {}),
    ...(typeof capabilities?.reasoning === 'boolean' ? { reasoning: capabilities.reasoning } : {}),
    ...(typeof raw.context_length === 'number' && Number.isInteger(raw.context_length) && raw.context_length >= 0 ? { limit: { context: raw.context_length } } : {}),
  }
  const encoded = JSON.stringify(raw)
  return { id: raw.id, metadata, providerMetadata: encoded.length <= 65_536 ? raw : { id: raw.id } }
}

export function providerModelMetadata(raw: Record<string, unknown>): ModelMetadata {
  return normalize(raw)?.metadata ?? {}
}

/** GET {base_url}/models. The AI SDK has no listing API, so we call the endpoint directly. */
export async function listRemoteModels(
  provider: Pick<ProviderInterface, 'protocol' | 'base_url'>,
  apiKey: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<RemoteModel[]> {
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
  const body = (await res.json()) as { data?: unknown[] }
  return (body.data ?? []).flatMap(value => {
    const normalized = normalize(object(value) ?? {})
    return normalized ? [normalized] : []
  }).sort((left, right) => left.id.localeCompare(right.id))
}
