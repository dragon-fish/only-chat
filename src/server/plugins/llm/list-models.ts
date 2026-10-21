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

function retained(id: string, raw: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(raw).length <= 65_536 ? raw : { id }
}

/**
 * A Workers AI catalogue entry: `id` is an internal UUID, `name` is the id requests use, and
 * capabilities arrive as `{ property_id, value }` pairs with string values.
 */
function normalizeWorkersAi(raw: Record<string, unknown>, properties: unknown[]): RemoteModel | null {
  if (typeof raw.name !== 'string' || !raw.name) return null
  const property = (id: string) => properties.map(object).find(item => item?.property_id === id)?.value
  const context = Number(property('context_window'))
  const metadata: ModelMetadata = {
    ...(typeof raw.description === 'string' && raw.description ? { description: raw.description } : {}),
    ...(property('vision') === 'true' ? { modalities: { input: ['text', 'image'], output: ['text'] } } : {}),
    ...(property('reasoning') === 'true' ? { reasoning: true } : {}),
    ...(property('function_calling') === 'true' ? { tool_call: true } : {}),
    ...(Number.isInteger(context) && context > 0 ? { limit: { context } } : {}),
  }
  return { id: raw.name, metadata, providerMetadata: retained(raw.name, raw) }
}

function normalize(raw: Record<string, unknown>): RemoteModel | null {
  if (Array.isArray(raw.properties) && object(raw.task)) return normalizeWorkersAi(raw, raw.properties)
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
  return { id: raw.id, metadata, providerMetadata: retained(raw.id, raw) }
}

export function providerModelMetadata(raw: Record<string, unknown>): ModelMetadata {
  return normalize(raw)?.metadata ?? {}
}

// Workers AI's OpenAI-compatible base has no `/models`; its catalogue is the account-level
// `/ai/models/search`, which pages through every task and wraps entries in `result`.
const WORKERS_AI_BASE = /^(https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai)\/v1\/?$/
const WORKERS_AI_PAGE_SIZE = 100

async function fetchJson(url: string, headers: Record<string, string>, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, { headers })
  if (!res.ok) throw new Error(`model listing failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function listWorkersAiModels(root: string, headers: Record<string, string>, fetchFn: typeof fetch): Promise<unknown[]> {
  const entries: unknown[] = []
  for (let page = 1; ; page++) {
    // Only Text Generation models are reachable through `/v1/chat/completions`; the other tasks
    // (embeddings, text-to-image, speech, ...) have no OpenAI-compatible route we could call.
    const query = new URLSearchParams({ task: 'Text Generation', per_page: String(WORKERS_AI_PAGE_SIZE), page: String(page) })
    const body = await fetchJson(`${root}/models/search?${query}`, headers, fetchFn) as { result?: unknown[] }
    const result = body.result ?? []
    entries.push(...result)
    if (result.length < WORKERS_AI_PAGE_SIZE) return entries
  }
}

/**
 * GET {base_url}/models, or the Workers AI catalogue for a Workers AI base. The AI SDK has no
 * listing API, so we call the endpoint directly.
 */
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
  const headers: Record<string, string> = provider.protocol === 'anthropic'
    ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey ?? ''}` }
  const workersAi = WORKERS_AI_BASE.exec(provider.base_url)
  const entries = workersAi
    ? await listWorkersAiModels(workersAi[1]!, headers, fetchFn)
    : ((await fetchJson(`${provider.base_url.replace(/\/$/, '')}/models`, headers, fetchFn)) as { data?: unknown[] }).data ?? []
  return entries.flatMap(value => {
    const normalized = normalize(object(value) ?? {})
    return normalized ? [normalized] : []
  }).sort((left, right) => left.id.localeCompare(right.id))
}
