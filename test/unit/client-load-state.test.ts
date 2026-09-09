// @vitest-environment happy-dom
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/client/app.vue'
import { authClient } from '@/client/lib/auth-client'
import { api } from '@/client/lib/api'
import { createAppRouter } from '@/client/router'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import { modelRecords, provider } from './provider-fixtures'
import type { Conversation } from '@/shared/models'

vi.mock('@/client/lib/auth-client', () => ({
  authClient: {
    getSession: vi.fn(),
    signOut: vi.fn(),
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
  },
}))

describe('collection load state', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  // Starting private requests before auth resolves would leak work into the guest entry flow.
  it('does not connect or load private collections for a guest', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({ data: null, error: null } as never)
    const fetch = vi.fn(() => { throw new Error('private request started') })
    vi.stubGlobal('fetch', fetch)
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter(createMemoryHistory())
    await router.push('/login')
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp(App).use(pinia).use(router)

    app.mount(host)
    await vi.waitFor(() => expect(vi.mocked(authClient.getSession)).toHaveBeenCalledOnce())
    await Promise.resolve()

    const sync = useSyncStore(pinia)
    const config = useConfigStore(pinia)
    expect(fetch).not.toHaveBeenCalled()
    expect(sync.status).toBe('closed')
    expect(sync.conversationsLoaded).toBe(false)
    expect(sync.projectsLoaded).toBe(false)
    expect(sync.settingsLoaded).toBe(false)
    expect(config.loaded).toBe(false)
    app.unmount()
  })

  // A response from the previous identity must not repopulate reset collection state.
  it('invalidates pending private loads while clearing sync and config state', async () => {
    const sync = useSyncStore()
    const config = useConfigStore()
    let finishConversations!: (value: Conversation[]) => void
    let finishProviders!: (value: typeof config.providerRecords) => void
    vi.spyOn(api, 'conversations').mockImplementation(() => new Promise(resolve => { finishConversations = resolve }))
    vi.spyOn(api, 'providers').mockImplementation(() => new Promise(resolve => { finishProviders = resolve }))
    sync.applyEvent({ type: 'project.created', project: { id: 7, user_id: 1, name: 'Old', icon_attachment_id: null, system_prompt: null, provider_id: null, model_id: null, params: null, created_at: 1, updated_at: 1 } })
    const oldConversation: Conversation = { id: 9, user_id: 1, project_id: null, title: 'Old chat', head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], created_at: 1, updated_at: 1, archived_at: null }
    sync.applyEvent({ type: 'conversation.created', conversation: oldConversation })
    sync.applyEvent({ type: 'message.created', message: { id: 11, conversation_id: 9, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'private' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1 } })
    sync.applyEvent({ type: 'settings.updated', settings: { plugins: { old: true } } })
    sync.beginOptimistic('old-request', { kind: 'tool_result', messageId: 11, part: { type: 'tool_result', call_id: 'old-call', name: 'old-tool', content: { ok: true } } })
    config.providerRecords = [provider]
    config.retainModels(modelRecords)
    config.catalogProviders = [{ id: 'old', name: 'Old', api: 'https://old.test' }]
    const oldConversations = sync.loadConversations()
    const oldProviders = config.load()

    sync.reset()
    config.reset()
    finishConversations([oldConversation])
    finishProviders([provider])
    await Promise.all([oldConversations, oldProviders])

    expect(sync.projects.size).toBe(0)
    expect(sync.conversations.size).toBe(0)
    expect(sync.messages.size).toBe(0)
    expect(sync.optimisticMutations.size).toBe(0)
    expect(sync.settings).toEqual({ plugins: {} })
    expect(sync.conversationsLoaded).toBe(false)
    expect(sync.status).toBe('closed')
    expect(config.providerRecords).toEqual([])
    expect(config.modelsByRef).toEqual({})
    expect(config.catalogProviders).toEqual([])
    expect(config.loaded).toBe(false)
  })

  // Marking an unknown/failed collection as loaded would expose a false empty state.
  it.each([
    ['conversations', 'loadConversations', 'conversationsLoaded', 'conversationsError', []],
    ['projects', 'loadProjects', 'projectsLoaded', 'projectsError', []],
    ['me', 'loadSettings', 'settingsLoaded', 'settingsError', { settings: { plugins: { search: true } } }],
  ] as const)('distinguishes failed, retried and loaded /api/%s collections', async (path, method, loaded, error, response) => {
    const store = useSyncStore()
    expect(store[loaded]).toBe(false)
    expect(store[error]).toBeNull()
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe(`/api/${path}`)
      return new Response('{"error":"unavailable"}', { status: 503 })
    })
    await expect(store[method]()).rejects.toThrow('503')
    expect(store[loaded]).toBe(false)
    expect(store[error]).toContain('503')
    vi.stubGlobal('fetch', async () => Response.json(response))
    await store[method]()
    expect(store[loaded]).toBe(true)
    expect(store[error]).toBeNull()
    if (path === 'me') expect(store.settings.plugins).toEqual({ search: true })
  })

  // An empty message response must end the loading skeleton just like a nonempty response.
  it('records an empty loaded message collection', async () => {
    const store = useSyncStore()
    vi.stubGlobal('fetch', async () => Response.json([]))
    expect(store.loadedMessageConversations.has(42)).toBe(false)
    await store.loadMessages(42)
    expect(store.loadedMessageConversations.has(42)).toBe(true)
    expect(store.pathFor(42)).toEqual([])
  })

  it('does not treat a live message bucket as loaded history', () => {
    // A snapshot can contain only the in-flight message, while its ancestors still need REST.
    const store = useSyncStore()
    store.applyEvent({ type: 'snapshot', inflight: [{
      id: 9, conversation_id: 42, parent_id: 8, seq: 2, role: 'assistant', parts: [],
      provider_id: null, model_id: null, usage: null, status: 'streaming', error: null, created_at: 1,
    }] })
    expect(store.messages.has(42)).toBe(true)
    expect(store.loadedMessageConversations.has(42)).toBe(false)
  })

  // A provider/model fetch failure must not turn into a loaded-empty model picker.
  it('exposes config load failures and clears them on successful retry', async () => {
    const config = useConfigStore()
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }))
    await expect(config.load()).rejects.toThrow('503')
    expect(config.loaded).toBe(false)
    expect(config.loadError).toContain('503')
    vi.stubGlobal('fetch', async () => Response.json([]))
    await config.load()
    expect(config.loaded).toBe(true)
    expect(config.loadError).toBeNull()
  })
})
