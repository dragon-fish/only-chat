import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'

describe('collection load state', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  // Marking an unknown/failed collection as loaded would expose a false empty state.
  it.each([
    ['sessions', 'loadSessions', 'sessionsLoaded', 'sessionsError', []],
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
    expect(store.loadedMessageSessions.has(42)).toBe(false)
    await store.loadMessages(42)
    expect(store.loadedMessageSessions.has(42)).toBe(true)
    expect(store.pathFor(42)).toEqual([])
  })

  it('does not treat a live message bucket as loaded history', () => {
    // A snapshot can contain only the in-flight message, while its ancestors still need REST.
    const store = useSyncStore()
    store.applyEvent({ type: 'snapshot', inflight: [{
      id: 9, session_id: 42, parent_id: 8, seq: 2, role: 'assistant', parts: [],
      provider_id: null, model_id: null, usage: null, status: 'streaming', error: null, created_at: 1,
    }] })
    expect(store.messages.has(42)).toBe(true)
    expect(store.loadedMessageSessions.has(42)).toBe(false)
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
