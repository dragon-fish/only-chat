// @vitest-environment happy-dom
import { createApp, nextTick, shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@/client/app.vue'
import { authClient } from '@/client/lib/auth-client'
import { createAppRouter } from '@/client/router'
import { useAuthStore } from '@/client/stores/auth'
import { useConfigStore } from '@/client/stores/config'
import { useSyncStore } from '@/client/stores/sync'
import { provider } from './provider-fixtures'
import type { Conversation } from '@/shared/models'

vi.mock('@/client/lib/auth-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/client/lib/auth-client')>(),
  authClient: {
    useSession: () => shallowRef({ isPending: true }),
    getSession: vi.fn(),
    signOut: vi.fn(),
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
  },
}))

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeSocket.instances.push(this) }
  send(value: string) { this.sent.push(value) }
  close(code = 1000) { this.closed = true; this.readyState = 3; this.onclose?.({ code }) }
  open() { this.readyState = 1; this.onopen?.() }
}

const sessionFor = (id: number) => ({
  session: {
    id: `session-${id}`, token: `token-${id}`, userId: String(id), expiresAt: new Date('2099-01-01'),
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  },
  user: {
    id: String(id), name: `User ${id}`, email: `user${id}@example.com`, emailVerified: false,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), image: null,
  },
})

const conversationFor = (userId: number): Conversation => ({
  id: userId * 10, user_id: userId, project_id: null, title: `User ${userId} chat`, head_message_id: null,
  provider_id: null, model_id: null, system_prompt: null, params: null, tools: [], tools_enabled: true, created_at: userId, updated_at: userId, archived_at: null,
})

let cleanup = () => {}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  cleanup()
  cleanup = () => {}
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function submitLogin(email: string) {
  await vi.waitFor(() => expect(document.querySelector('#login-email')).not.toBeNull())
  await type('#login-email', email)
  await type('#login-password', 'correct horse battery staple')
  document.querySelector('#login-email')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

async function mountGuestApp(fetch: typeof globalThis.fetch) {
  vi.stubGlobal('fetch', fetch)
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter(createMemoryHistory())
  await router.push('/login')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(App).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  return { auth: useAuthStore(pinia), config: useConfigStore(pinia), router, sync: useSyncStore(pinia) }
}

describe('real App authentication lifecycle', () => {
  // Keeping initialization in onMounted would never start these private resources after guest login.
  it('starts private synchronization once when the mounted guest logs in', async () => {
    vi.mocked(authClient.getSession)
      .mockResolvedValueOnce({ data: null, error: null } as never)
      .mockResolvedValue({ data: sessionFor(1), error: null } as never)
    vi.mocked(authClient.signIn.email).mockResolvedValue({ data: { user: sessionFor(1).user }, error: null } as never)
    const privateRequests: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/site-config') return Response.json({ allowRegister: false })
      privateRequests.push(path)
      if (path === '/api/me') return Response.json({ settings: { plugins: {} } })
      if (path === '/api/conversations') return Response.json([conversationFor(1)])
      if (path === '/api/projects' || path === '/api/providers') return Response.json([])
      throw new Error(`Unexpected request: ${path}`)
    })
    const { auth, config, router, sync } = await mountGuestApp(fetch)

    await submitLogin('user1@example.com')

    await vi.waitFor(() => expect({
      auth: auth.authUser?.email,
      config: config.loaded,
      conversations: sync.conversationsLoaded,
      projects: sync.projectsLoaded,
      route: router.currentRoute.value.path,
      settings: sync.settingsLoaded,
    }).toEqual({ auth: 'user1@example.com', config: true, conversations: true, projects: true, route: '/new', settings: true }))
    expect(sync.conversationList.map(item => item.title)).toEqual(['User 1 chat'])
    expect(FakeSocket.instances).toHaveLength(1)
    expect(privateRequests.sort()).toEqual(['/api/conversations', '/api/me', '/api/projects', '/api/providers'])
    expect(document.querySelector('#page-header [aria-label^="选择模型"]')).not.toBeNull()
    expect(document.querySelector('#page-header [aria-label="会话设置"]')).not.toBeNull()

    await auth.refresh()
    await nextTick()
    expect(FakeSocket.instances).toHaveLength(1)
    expect(privateRequests).toHaveLength(4)
  })

  it('clears private state and navigates to login on an authentication socket close', async () => {
    vi.mocked(authClient.getSession).mockResolvedValueOnce({ data: null, error: null } as never)
      .mockResolvedValue({ data: sessionFor(1), error: null } as never)
    vi.mocked(authClient.signIn.email).mockResolvedValue({ data: { user: sessionFor(1).user }, error: null } as never)
    const { auth, config, router, sync } = await mountGuestApp(async input => {
      if (String(input) === '/api/me') return Response.json({ settings: { plugins: {} } })
      if (String(input) === '/api/conversations') return Response.json([conversationFor(1)])
      return Response.json([])
    })
    await submitLogin('user1@example.com')
    await vi.waitFor(() => expect(sync.conversationList).toHaveLength(1))
    FakeSocket.instances[0]!.close(4001)
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/login'))
    expect(auth.authUser).toBeNull()
    expect(sync.conversationList).toEqual([])
    expect(config.providerRecords).toEqual([])
  })

  // Missing teardown or request fencing would expose user 1 data after user 2 logs in.
  it('clears private state and stale loads before a second user starts', async () => {
    vi.mocked(authClient.getSession)
      .mockResolvedValueOnce({ data: null, error: null } as never)
      .mockResolvedValueOnce({ data: sessionFor(1), error: null } as never)
      .mockResolvedValueOnce({ data: sessionFor(2), error: null } as never)
    vi.mocked(authClient.signIn.email).mockResolvedValue({ data: { user: sessionFor(1).user }, error: null } as never)
    vi.mocked(authClient.signOut).mockResolvedValue({ data: { success: true }, error: null } as never)
    let activeUser = 1
    let finishOldConversations!: (response: Response) => void
    const oldConversations = new Promise<Response>(resolve => { finishOldConversations = resolve })
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/site-config') return Response.json({ allowRegister: false })
      const requestUser = activeUser
      if (path === '/api/me') return Response.json({ settings: { plugins: { [`user-${requestUser}`]: true } } })
      if (path === '/api/conversations') return requestUser === 1 ? oldConversations : Response.json([conversationFor(2)])
      if (path === '/api/projects') return Response.json([])
      if (path === '/api/providers') return Response.json([{ ...provider, id: requestUser, user_id: requestUser, name: `User ${requestUser} provider` }])
      throw new Error(`Unexpected request: ${path}`)
    })
    const { auth, config, router, sync } = await mountGuestApp(fetch)
    await submitLogin('user1@example.com')
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    sync.send({ type: 'stop', conversation_id: 10 })

    await auth.signOut()

    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/login'))
    expect(FakeSocket.instances[0]!.closed).toBe(true)
    expect(sync.conversations).toHaveLength(0)
    expect(sync.projects).toHaveLength(0)
    expect(sync.messages).toHaveLength(0)
    expect(sync.settings).toEqual({ plugins: {} })
    expect(config.providerRecords).toEqual([])
    expect(config.modelsByRef).toEqual({})

    activeUser = 2
    vi.mocked(authClient.signIn.email).mockResolvedValue({ data: { user: sessionFor(2).user }, error: null } as never)
    await submitLogin('user2@example.com')
    await vi.waitFor(() => expect({
      auth: auth.authUser?.email,
      config: config.loaded,
      conversations: sync.conversationsLoaded,
      route: router.currentRoute.value.path,
      sockets: FakeSocket.instances.length,
    }).toEqual({ auth: 'user2@example.com', config: true, conversations: true, route: '/new', sockets: 2 }))
    finishOldConversations(Response.json([conversationFor(1)]))
    await oldConversations
    await nextTick()

    expect(sync.conversationList.map(item => item.title)).toEqual(['User 2 chat'])
    expect(config.providerRecords.map(item => item.name)).toEqual(['User 2 provider'])
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.instances[1]!.open()
    expect(FakeSocket.instances[1]!.sent).toEqual([])
  })
})
