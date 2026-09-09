// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import SidebarGlobalFooter from '@/client/components/layout/sidebar-global-footer.vue'
import { SidebarProvider } from '@/client/ui/sidebar'
import { useAuthStore } from '@/client/stores/auth'
import { authClient } from '@/client/lib/auth-client'

vi.mock('@/client/lib/auth-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/client/lib/auth-client')>(),
  authClient: { signOut: vi.fn(), getSession: vi.fn() },
}))

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

async function mount(role: 'user' | 'admin', id = '2') {
  const pinia = createPinia()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/new')
  const auth = useAuthStore(pinia)
  auth.authUser = { id, name: 'Real Person', email: 'real@example.com', emailVerified: false, createdAt: new Date(), updatedAt: new Date(), role, banned: false }
  auth.ready = true
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(SidebarProvider, {}, () => h(SidebarGlobalFooter)) }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  return auth
}

it.each([['user', '2', false], ['admin', '2', true], ['user', '1', true]] as const)('shows real identity and correct navigation for %s uid %s', async (role, id, admin) => {
  await mount(role, id)
  expect(document.body.textContent).toContain('Real Person')
  expect(document.body.textContent).toContain('real@example.com')
  const trigger = document.querySelector<HTMLButtonElement>('[data-account-menu]')!
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('a[href="/settings/account"]')).not.toBeNull())
  expect(Boolean(document.querySelector('a[href="/admin/users"]'))).toBe(admin)
})

it('signs out through the auth store and clears the rendered identity', async () => {
  const auth = await mount('user')
  vi.spyOn(authClient, 'signOut').mockResolvedValue({ data: { success: true }, error: null })
  document.querySelector<HTMLButtonElement>('[data-account-menu]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('[data-sign-out]')).not.toBeNull())
  document.querySelector<HTMLElement>('[data-sign-out]')!.click()
  await vi.waitFor(() => expect(auth.authUser).toBeNull())
  await nextTick()
  expect(document.body.textContent).not.toContain('real@example.com')
})
