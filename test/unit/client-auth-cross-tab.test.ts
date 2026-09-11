// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

// The storage event is the real Better Auth 1.7.3 cross-tab transport; only HTTP is substituted.
it('tears down Alice and starts Bob when another tab changes the cookie account', async () => {
  let currentUser: number | null = 2
  class Socket {
    static instances: Socket[] = []
    readyState = 0
    closed = false
    constructor() { Socket.instances.push(this) }
    close() { this.closed = true }
    send() {}
  }
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost:3000').pathname
    if (path === '/api/auth/get-session') return Response.json(currentUser === null ? null : {
      session: { id: `auth-${currentUser}`, userId: String(currentUser), token: `synthetic-${currentUser}`, expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      user: { id: String(currentUser), name: `User ${currentUser}`, email: `user${currentUser}@example.com`, emailVerified: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', image: null },
    })
    if (path === '/api/me') return Response.json({ settings: { plugins: { [`user-${currentUser}`]: true } } })
    if (path === '/api/plugins/config') return Response.json({})
    if (path === '/api/conversations') return Response.json([{ id: currentUser! * 10, user_id: currentUser, title: `Private ${currentUser}`, project_id: null, head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], created_at: 0, updated_at: 0, archived_at: null }])
    if (path === '/api/projects' || path === '/api/providers') return Response.json([])
    if (path === '/api/site-settings') return Response.json({ allowRegister: false })
    throw new Error(`Unexpected request ${path}`)
  })
  // Import after substituting fetch because Better Auth captures the transport on construction.
  const [{ default: App }, { createAppRouter }, { useAuthStore }, { useSyncStore }, { useConfigStore }] = await Promise.all([
    import('@/client/app.vue'), import('@/client/router'), import('@/client/stores/auth'), import('@/client/stores/sync'), import('@/client/stores/config'),
  ])
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter(createMemoryHistory())
  await router.push('/new')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(App).use(pinia).use(router)
  app.mount(host)
  cleanup = () => { app.unmount(); disposePinia(pinia) }
  const auth = useAuthStore(pinia)
  const sync = useSyncStore(pinia)
  const config = useConfigStore(pinia)
  await vi.waitFor(() => expect(sync.conversationList.map(row => row.title)).toEqual(['Private 2']))
  currentUser = 3
  window.dispatchEvent(new StorageEvent('storage', { key: 'better-auth.message', newValue: JSON.stringify({ event: 'session', data: { trigger: 'signout' }, clientId: 'other-tab' }) }))
  await vi.waitFor(() => expect(auth.authUser?.id).toBe('3'))
  await vi.waitFor(() => expect(sync.conversationList.map(row => row.title)).toEqual(['Private 3']))
  expect(Socket.instances[0]!.closed).toBe(true)
  expect(Socket.instances).toHaveLength(2)
  expect(sync.settings.plugins).toEqual({ 'user-3': true })
  currentUser = null
  window.dispatchEvent(new StorageEvent('storage', { key: 'better-auth.message', newValue: JSON.stringify({ event: 'session', data: { trigger: 'signout' }, clientId: 'other-tab' }) }))
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/login'))
  await nextTick()
  expect(sync.conversationList).toEqual([])
  expect(config.providerRecords).toEqual([])
})
