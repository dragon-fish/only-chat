// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authClient } from '@/client/lib/auth-client'
import AuthLoginView from '@/client/views/auth-login.vue'
import AuthRegisterView from '@/client/views/auth-register.vue'
import { useAuthStore } from '@/client/stores/auth'

vi.mock('@/client/lib/auth-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/client/lib/auth-client')>(),
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

let cleanup = () => {}
beforeEach(() => { vi.stubGlobal('fetch', async () => Response.json({ allowRegister: false })) })

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

async function mountAuth(path: string) {
  const pinia = createPinia()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: AuthLoginView },
      { path: '/register', component: AuthRegisterView },
      { path: '/new', component: { template: '<main>private</main>' } },
      { path: '/settings/providers', component: { template: '<main>settings</main>' } },
    ],
  })
  await router.push(path)
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(RouterView).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  return { authStore: useAuthStore(pinia), router }
}

describe('authentication entry pages', () => {
  it.each([false, true])('shows the registration link only when registration is %s', async allowRegister => {
    vi.stubGlobal('fetch', async () => Response.json({ allowRegister }))
    await mountAuth('/login')
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(document.querySelector('a[href="/register"]') !== null).toBe(allowRegister)
  })

  it.each([false, true])('passes the chosen remember-login value %s to Better Auth', async rememberMe => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({ data: null, error: { code: 'INVALID_EMAIL_OR_PASSWORD' } } as never)
    await mountAuth('/login')
    await type('#login-email', 'owner@example.com')
    await type('#login-password', 'wrong password')
    const checkbox = document.querySelector<HTMLButtonElement>('#login-remember')
    expect(checkbox).not.toBeNull()
    if ((checkbox!.getAttribute('aria-checked') === 'true') !== rememberMe) checkbox!.click()
    await nextTick()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(authClient.signIn.email).toHaveBeenCalledWith({ email: 'owner@example.com', password: 'wrong password', rememberMe }))
  })
  // Dropping the post-login refresh or redirect would strand a valid user on the entry page.
  it('signs in, refreshes auth state and returns to the preserved private route', async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({ data: { user: authSession.user }, error: null } as never)
    vi.mocked(authClient.getSession).mockResolvedValue({ data: authSession, error: null } as never)
    const { authStore, router } = await mountAuth('/login?redirect=%2Fsettings%2Fproviders')
    await type('#login-email', 'owner@example.com')
    await type('#login-password', 'correct horse battery staple')

    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings/providers'))
    expect(authStore.authUser).toMatchObject({ email: 'owner@example.com' })
  })

  // Treating a framework failure as success would navigate away without an authenticated session.
  it('keeps the login form in place and translates invalid credentials', async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      data: null,
      error: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password', status: 401, statusText: 'UNAUTHORIZED' },
    } as never)
    const { router } = await mountAuth('/login')
    await type('#login-email', 'owner@example.com')
    await type('#login-password', 'wrong password')

    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('邮箱或密码不正确'))
    expect(router.currentRoute.value.path).toBe('/login')
    expect(authClient.getSession).not.toHaveBeenCalled()
  })

  // A disabled public setting must hide the form even though the server still enforces the policy.
  it('replaces registration fields with a closed-registration message', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe('/api/site-config')
      return Response.json({ allowRegister: false })
    })

    await mountAuth('/register')

    await vi.waitFor(() => expect(document.body.textContent).toContain('注册未开放'))
    expect(document.querySelector('form')).toBeNull()
    expect(document.querySelector('a[href="/login"]')).not.toBeNull()
  })

  // Omitting the framework sign-up call would render a form that can never create an account.
  it('registers when enabled and enters the authenticated destination', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ allowRegister: true }))
    vi.mocked(authClient.signUp.email).mockResolvedValue({ data: { user: authSession.user }, error: null } as never)
    vi.mocked(authClient.getSession).mockResolvedValue({ data: authSession, error: null } as never)
    const { authStore, router } = await mountAuth('/register?redirect=%2Fsettings%2Fproviders')
    await vi.waitFor(() => expect(document.querySelector('#register-name')).not.toBeNull())
    await type('#register-name', 'Owner')
    await type('#register-email', 'owner@example.com')
    await type('#register-password', 'correct horse battery staple')

    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings/providers'))
    expect(authStore.authUser).toMatchObject({ email: 'owner@example.com' })
  })
})
