import { CodexOAuthPollResponseSchema, CodexOAuthStartResponseSchema, type AttachmentCheckResponse, type AttachmentUploadResponse, type BulkModelStateInput, type BulkModelStateResponse, type CatalogProviderSummary, type CatalogRefreshJobStatus, type CatalogRefreshStartResponse, type CatalogStatus, type CodexProviderUpdate, type FetchModelsResponse, type ModelRef, type ModelWriteInput, type ProviderWriteInput } from '@/shared/api'
import type { Message, ModelPage, ModelQuery, ModelWithMetadata, Project, ProviderWithInterfaces, Session, User } from '@/shared/models'
import type { PresetProvider } from '@/server/plugins/llm/presets'

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}, onWarning?: (warning: string) => void): Promise<T> {
  const res = await fetch(path, {
    ...init,
    method,
    // After `...init` on purpose: a caller's custom headers are merged in below, never dropping content-type.
    headers: body instanceof Blob ? init.headers : { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = ((await res.json()) as { error?: string }).error ?? '' } catch { /* ignore */ }
    throw new Error(`${method} ${path} failed: ${res.status} ${detail}`.trim())
  }
  const warning = res.headers.get('X-Provider-Association-Warning')
  if (warning) onWarning?.(warning)
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value))
  return params.size ? `?${params}` : ''
}

export const api = {
  me: () => request<User>('GET', '/api/me'),
  presets: () => request<PresetProvider[]>('GET', '/api/presets'),
  sessions: () => request<Session[]>('GET', '/api/sessions'),
  projects: () => request<Project[]>('GET', '/api/projects'),
  messages: (sessionId: number) => request<Message[]>('GET', `/api/sessions/${sessionId}/messages`),
  providers: () => request<ProviderWithInterfaces[]>('GET', '/api/providers'),
  createProvider: (input: ProviderWriteInput, onWarning?: (warning: string) => void) => request<ProviderWithInterfaces>('POST', '/api/providers', input, {}, onWarning),
  startCodexOAuth: async () => CodexOAuthStartResponseSchema.parse(await request<unknown>('POST', '/api/codex/oauth/start')),
  reconnectCodexProvider: async (id: number) => CodexOAuthStartResponseSchema.parse(await request<unknown>('POST', `/api/providers/${id}/codex/reconnect`)),
  pollCodexOAuth: async (flowId: string) => CodexOAuthPollResponseSchema.parse(await request<unknown>('POST', `/api/codex/oauth/${flowId}/poll`)),
  cancelCodexOAuth: (flowId: string) => request<void>('DELETE', `/api/codex/oauth/${flowId}`),
  updateProvider: (id: number, input: ProviderWriteInput, onWarning?: (warning: string) => void) => request<ProviderWithInterfaces>('PUT', `/api/providers/${id}`, input, {}, onWarning),
  updateCodexProvider: (id: number, input: CodexProviderUpdate) => request<ProviderWithInterfaces>('PUT', `/api/providers/${id}`, input),
  disconnectCodexProvider: (id: number) => request<void>('POST', `/api/providers/${id}/codex/disconnect`),
  deleteProvider: (id: number) => request<void>('DELETE', `/api/providers/${id}`),
  fetchModels: (providerId: number) => request<FetchModelsResponse>('POST', `/api/providers/${providerId}/fetch-models`),
  models: (providerId: number, query: Partial<ModelQuery> = {}, signal?: AbortSignal) => request<ModelPage>('GET', `/api/providers/${providerId}/models${queryString(query)}`, undefined, { signal }),
  queryModels: (query: Partial<ModelQuery> = {}, signal?: AbortSignal) => request<ModelPage>('GET', `/api/models${queryString(query)}`, undefined, { signal }),
  modelByRef: (ref: ModelRef, signal?: AbortSignal) => request<ModelWithMetadata>('GET', `/api/providers/${ref.provider_id}/models/by-ref${queryString({ model_id: ref.model_id })}`, undefined, { signal }),
  createModel: (providerId: number, input: ModelWriteInput) => request<ModelWithMetadata>('POST', `/api/providers/${providerId}/models`, input),
  updateModel: (providerId: number, rowId: number, input: Partial<ModelWriteInput>) => request<ModelWithMetadata>('PUT', `/api/providers/${providerId}/models/${rowId}`, input),
  updateModels: (providerId: number, input: BulkModelStateInput) => request<BulkModelStateResponse>('PUT', `/api/providers/${providerId}/models/bulk`, input),
  deleteModel: (providerId: number, rowId: number) => request<void>('DELETE', `/api/providers/${providerId}/models/${rowId}`),
  catalogStatus: () => request<CatalogStatus>('GET', '/api/model-catalog/status'),
  catalogProviders: (query = '', signal?: AbortSignal) => request<CatalogProviderSummary[]>('GET', `/api/model-catalog/providers${queryString({ q: query })}`, undefined, { signal }),
  refreshCatalog: () => request<CatalogRefreshStartResponse>('POST', '/api/model-catalog/refresh'),
  catalogRefreshStatus: (instanceId: string) => request<CatalogRefreshJobStatus>('GET', `/api/model-catalog/refresh/${encodeURIComponent(instanceId)}`),
  checkAttachment: (sha256: string) => request<AttachmentCheckResponse>('POST', '/api/attachments/check', { sha256 }),
  uploadAttachment: (sha256: string, blob: Blob, w: number, h: number) =>
    request<AttachmentUploadResponse>('PUT', `/api/attachments/${sha256}?w=${w}&h=${h}`, blob, { headers: { 'content-type': blob.type } }),
  attachmentUrl: (id: number) => `/api/attachments/${id}`,
}
