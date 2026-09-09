import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authClient } from '@/client/lib/auth-client'
import { ApiError, api } from '@/client/lib/api'
import { useAuthStore } from '@/client/stores/auth'

vi.mock('@/client/lib/auth-client', () => ({
  authClient: {
    getSession: vi.fn(),
    signOut: vi.fn(),
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
  },
}))

const authSession = {
  session: {
    id: 'session-1', token: 'token-1', userId: '1', expiresAt: new Date('2099-01-01'),
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
  },
  user: {
    id: '1', name: 'Owner', email: 'owner@example.com', emailVerified: false,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), image: null,
  },
}

const secondAuthSession = {
  ...authSession,
  session: { ...authSession.session, id: 'session-2', token: 'token-2', userId: '2' },
  user: { ...authSession.user, id: '2', name: 'Second', email: 'second@example.com' },
}

describe('frontend authentication state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(authClient.getSession).mockReset()
    vi.mocked(authClient.signOut).mockReset()
  })

  afterEach(() => vi.unstubAllGlobals())

  // Removing the refresh assignment would leave authenticated visitors in the guest flow.
  it('marks initialization ready and exposes the current session user', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({ data: authSession, error: null } as never)
    const authStore = useAuthStore()

    await authStore.refresh()

    expect(authStore.ready).toBe(true)
    expect(authStore.authSession).toEqual(authSession)
    expect(authStore.authUser).toMatchObject({ email: 'owner@example.com' })
  })

  // Starting duplicate initialization reads can make their completion order define auth state.
  it('deduplicates concurrent initialization refreshes', async () => {
    let finish!: (value: unknown) => void
    vi.mocked(authClient.getSession).mockImplementation(() => new Promise(resolve => { finish = resolve }) as never)
    const authStore = useAuthStore()

    const first = authStore.refresh()
    const second = authStore.refresh()
    expect(authClient.getSession).toHaveBeenCalledOnce()
    finish({ data: authSession, error: null })
    await Promise.all([first, second])

    expect(authStore.authUser).toMatchObject({ email: 'owner@example.com' })
  })

  // A guest read started before login must not overwrite the explicitly refreshed new session.
  it('invalidates a slow refresh when auth changes', async () => {
    let finishGuest!: (value: unknown) => void
    let finishLogin!: (value: unknown) => void
    vi.mocked(authClient.getSession)
      .mockImplementationOnce(() => new Promise(resolve => { finishGuest = resolve }) as never)
      .mockImplementationOnce(() => new Promise(resolve => { finishLogin = resolve }) as never)
    const authStore = useAuthStore()

    const guest = authStore.refresh()
    const login = authStore.refresh(true)
    finishLogin({ data: secondAuthSession, error: null })
    await login
    finishGuest({ data: null, error: null })
    await guest

    expect(authStore.authSession).toEqual(secondAuthSession)
    expect(authStore.authUser).toMatchObject({ email: 'second@example.com' })
  })

  // Clearing credentials must permanently invalidate an already-started session read.
  it('does not restore a refresh response that completes after clear', async () => {
    let finish!: (value: unknown) => void
    vi.mocked(authClient.getSession).mockImplementation(() => new Promise(resolve => { finish = resolve }) as never)
    const authStore = useAuthStore()

    const pending = authStore.refresh()
    authStore.clear()
    finish({ data: authSession, error: null })
    await pending

    expect(authStore.authSession).toBeNull()
    expect(authStore.authUser).toBeNull()
  })

  // Failing to clear local state after server sign-out would leave private UI visible.
  it('clears the current session after signing out', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({ data: authSession, error: null } as never)
    vi.mocked(authClient.signOut).mockResolvedValue({ data: { success: true }, error: null } as never)
    const authStore = useAuthStore()
    await authStore.refresh()

    await authStore.signOut()

    expect(authStore.authSession).toBeNull()
    expect(authStore.authUser).toBeNull()
  })

  // A stale private session must not survive the first authenticated API rejection.
  it('throws a typed API error and clears auth state on 401', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({ data: authSession, error: null } as never)
    const authStore = useAuthStore()
    await authStore.refresh()
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Authentication required' }, { status: 401 }))

    const request = api.conversations()
    await expect(request).rejects.toBeInstanceOf(ApiError)
    await expect(request).rejects.toMatchObject({ status: 401, detail: 'Authentication required' })
    expect(authStore.authSession).toBeNull()
    expect(authStore.authUser).toBeNull()
  })

  // Authorization failures are not evidence that the login session itself expired.
  it('preserves auth state on 403', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({ data: authSession, error: null } as never)
    const authStore = useAuthStore()
    await authStore.refresh()
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Forbidden' }, { status: 403 }))

    await expect(api.conversations()).rejects.toMatchObject({ status: 403 })
    expect(authStore.authUser).toMatchObject({ email: 'owner@example.com' })
  })

  // Copying arbitrary response text into an exception could expose an upstream HTML error page.
  it('does not expose non-JSON response bodies in typed API errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('<h1>internal proxy details</h1>', { status: 502 }))

    await expect(api.conversations()).rejects.toMatchObject({ status: 502, detail: '' })
    await expect(api.conversations()).rejects.not.toThrow('internal proxy details')
  })
})
