import type { AttachmentCheckResponse, AttachmentUploadResponse, FetchModelsResponse, ModelInput, ProviderInput } from '@/shared/api'
import type { Message, Model, Project, Provider, Session, User } from '@/shared/models'
import type { PresetProvider } from '@/server/plugins/llm/presets'

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
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
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const api = {
  me: () => request<User>('GET', '/api/me'),
  presets: () => request<PresetProvider[]>('GET', '/api/presets'),
  sessions: () => request<Session[]>('GET', '/api/sessions'),
  projects: () => request<Project[]>('GET', '/api/projects'),
  messages: (sessionId: number) => request<Message[]>('GET', `/api/sessions/${sessionId}/messages`),
  providers: () => request<Provider[]>('GET', '/api/providers'),
  createProvider: (input: ProviderInput) => request<Provider>('POST', '/api/providers', input),
  updateProvider: (id: number, input: Partial<ProviderInput>) => request<Provider>('PUT', `/api/providers/${id}`, input),
  deleteProvider: (id: number) => request<void>('DELETE', `/api/providers/${id}`),
  fetchModels: (providerId: number) => request<FetchModelsResponse>('POST', `/api/providers/${providerId}/fetch-models`),
  models: (providerId: number, signal?: AbortSignal) => request<Model[]>('GET', `/api/providers/${providerId}/models`, undefined, { signal }),
  createModel: (providerId: number, input: ModelInput) => request<Model>('POST', `/api/providers/${providerId}/models`, input),
  updateModel: (providerId: number, rowId: number, input: Partial<ModelInput>) => request<Model>('PUT', `/api/providers/${providerId}/models/${rowId}`, input),
  deleteModel: (providerId: number, rowId: number) => request<void>('DELETE', `/api/providers/${providerId}/models/${rowId}`),
  checkAttachment: (sha256: string) => request<AttachmentCheckResponse>('POST', '/api/attachments/check', { sha256 }),
  uploadAttachment: (sha256: string, blob: Blob, w: number, h: number) =>
    request<AttachmentUploadResponse>('PUT', `/api/attachments/${sha256}?w=${w}&h=${h}`, blob, { headers: { 'content-type': blob.type } }),
  attachmentUrl: (id: number) => `/api/attachments/${id}`,
}
