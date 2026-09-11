import type { AttachmentCheckResponse, AttachmentUploadResponse, BulkModelStateInput, BulkModelStateResponse, CatalogProviderSummary, CatalogRefreshJobStatus, CatalogRefreshStartResponse, CatalogStatus, FetchModelsResponse, ModelRef, ModelWriteInput, ProviderWriteInput } from '@/shared/api'
import type { Message, ModelListSnapshot, ModelWithMetadata, Project, ProviderWithInterfaces, Conversation, User } from '@/shared/models'
import type { PresetProvider } from '@/server/plugins/llm/presets'
import type { AdminSiteSettings, AdminSiteSettingsUpdate, PublicSiteSettings } from '@/shared/auth'
import { useAuthStore } from '@/client/stores/auth'
import type { ArtifactDto, ArtifactPage, ArtifactRunDto, CreateImageRunInput, CreateImageRunResponse } from '@/shared/artifacts'
import type { PluginConfigStatusMap } from '@/shared/plugins'
import type { FileRecord } from '@/shared/workspace-files'

export class ApiError extends Error {
  constructor(readonly status: number, readonly detail: string, method: string, path: string) {
    super(`${method} ${path} failed: ${status}${detail ? ` ${detail}` : ''}`)
    this.name = 'ApiError'
  }
}

let unauthorizedHandler: (() => void | Promise<void>) | undefined

export function setUnauthorizedHandler(handler: (() => void | Promise<void>) | undefined): void {
  unauthorizedHandler = handler
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}, onWarning?: (warning: string) => void): Promise<T> {
  const auth = useAuthStore()
  const generation = auth.generation
  const res = await fetch(path, {
    ...init,
    method,
    // After `...init` on purpose: a caller's custom headers are merged in below, never dropping content-type.
    headers: body instanceof Blob ? init.headers : { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const body: unknown = await res.json()
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') detail = body.error
    } catch { /* A non-JSON body is intentionally not exposed to the UI. */ }
    const error = new ApiError(res.status, detail, method, path)
    if (res.status === 401 && generation === auth.generation) {
      auth.clear()
      try { await unauthorizedHandler?.() } catch { /* Navigation failure must not replace the API error. */ }
    }
    throw error
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
  siteSettings: () => request<PublicSiteSettings>('GET', '/api/site-settings'),
  adminSettings: () => request<AdminSiteSettings>('GET', '/api/admin/settings'),
  updateAdminSettings: (input: AdminSiteSettingsUpdate) => request<AdminSiteSettings>('PUT', '/api/admin/settings', input),
  me: () => request<User>('GET', '/api/me'),
  updatePluginConfig: (pluginId: string, patch: Record<string, unknown>) =>
    request<PluginConfigStatusMap>('PUT', `/api/plugins/${pluginId}/config`, patch),
  presets: () => request<PresetProvider[]>('GET', '/api/presets'),
  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  imageConversations: () => request<Conversation[]>('GET', '/api/conversations?kind=image'),
  projects: () => request<Project[]>('GET', '/api/projects'),
  messages: (conversationId: number) => request<Message[]>('GET', `/api/conversations/${conversationId}/messages`),
  providers: () => request<ProviderWithInterfaces[]>('GET', '/api/providers'),
  createProvider: (input: ProviderWriteInput, onWarning?: (warning: string) => void) => request<ProviderWithInterfaces>('POST', '/api/providers', input, {}, onWarning),
  updateProvider: (id: number, input: ProviderWriteInput, onWarning?: (warning: string) => void) => request<ProviderWithInterfaces>('PUT', `/api/providers/${id}`, input, {}, onWarning),
  deleteProvider: (id: number) => request<void>('DELETE', `/api/providers/${id}`),
  fetchModels: (providerId: number) => request<FetchModelsResponse>('POST', `/api/providers/${providerId}/fetch-models`),
  enabledModelSummary: (signal?: AbortSignal) => request<ModelListSnapshot>('GET', '/api/models/summary', undefined, { signal }),
  providerModelSummary: (providerId: number, signal?: AbortSignal) => request<ModelListSnapshot>('GET', `/api/providers/${providerId}/models/summary`, undefined, { signal }),
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
  createImageRun: (input: CreateImageRunInput) => request<CreateImageRunResponse>('POST', '/api/artifact-runs/image', input),
  artifactRun: (id: number) => request<ArtifactRunDto>('GET', `/api/artifact-runs/${id}`),
  artifactRuns: (conversationId: number) => request<ArtifactRunDto[]>('GET', `/api/artifact-runs${queryString({ conversation_id: conversationId })}`),
  cancelArtifactRun: (id: number) => request<ArtifactRunDto>('POST', `/api/artifact-runs/${id}/cancel`),
  artifacts: (query: { cursor?: string; limit?: number; conversation_id?: number } = {}) => request<ArtifactPage>('GET', `/api/artifacts${queryString({ kind: 'image', ...query })}`),
  artifact: (id: number) => request<ArtifactDto>('GET', `/api/artifacts/${id}`),
  deleteArtifact: (id: number) => request<void>('DELETE', `/api/artifacts/${id}`),
  artifactContentUrl: (id: number, variant?: 'gallery' | 'preview') => `/api/artifacts/${id}/content${queryString({ variant })}`,
  projectFiles: (projectId: number) => request<{ files: FileRecord[] }>('GET', `/api/projects/${projectId}/files`),
  conversationFiles: (conversationId: number) =>
    request<{ files: FileRecord[]; projectFiles: FileRecord[]; projectId: number | null }>('GET', `/api/conversations/${conversationId}/files`),
  workspaceFile: (id: number) => request<{ record: FileRecord; content: string; mime: string }>('GET', `/api/workspace-files/${id}`),
  // A link, not a fetch: the download is served as an attachment and the browser owns saving it.
  workspaceFileDownloadUrl: (id: number) => `/api/workspace-files/${id}/download`,
  deleteWorkspaceFile: (id: number) => request<void>('DELETE', `/api/workspace-files/${id}`),
}
