// @vitest-environment happy-dom
import { createApp, h, nextTick, type Component } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/client/stores/auth'
import { authClient } from '@/client/lib/auth-client'
import { api } from '@/client/lib/api'

vi.mock('@/client/lib/auth-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/client/lib/auth-client')>(),
  authClient: { getSession: vi.fn(), updateUser: vi.fn(), changePassword: vi.fn(), admin: { listUsers: vi.fn(), createUser: vi.fn(), setRole: vi.fn(), banUser: vi.fn(), unbanUser: vi.fn(), setUserPassword: vi.fn(), revokeUserSessions: vi.fn() } },
}))

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function mount(component: Component, auditEnabled = false) {
  if (!vi.isMockFunction(api.siteConfig)) vi.spyOn(api, 'siteConfig').mockResolvedValue({ allowRegister: false, audit: auditEnabled })
  document.body.innerHTML = '<div id="page-header"></div>'
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.authUser = { id: '1', name: 'Owner', email: 'owner@example.com', emailVerified: false, createdAt: new Date(), updatedAt: new Date(), banned: false }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/admin/users')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(component) }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  return auth
}
async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

it('exposes account and admin destinations on the mobile settings landing page', async () => {
  const view = await import('@/client/views/settings-index.vue')
  const auth = await mount(view.default)
  expect(document.querySelector('a[href="/settings/account"]')).not.toBeNull()
  expect(document.querySelector('a[href="/admin/users"]')).not.toBeNull()
  expect(document.querySelector('a[href="/admin/settings"]')).not.toBeNull()
  auth.authUser = { ...auth.authUser!, id: '2', role: 'user' }
  await nextTick()
  expect(document.querySelector('a[href="/admin/users"]')).toBeNull()
})

it('lists the audit pages for the owner only while audit is enabled', async () => {
  const view = await import('@/client/views/settings-index.vue')
  const auth = await mount(view.default, true)
  await vi.waitFor(() => expect(document.querySelector('a[href="/admin/audit/conversations"]')).not.toBeNull())
  expect(document.querySelector('a[href="/admin/audit/providers"]')).not.toBeNull()
  auth.authUser = { ...auth.authUser!, id: '2', role: 'admin' }
  await nextTick()
  expect(document.querySelector('a[href="/admin/audit/conversations"]')).toBeNull()
  cleanup()
  vi.restoreAllMocks()
  await mount(view.default, false)
  await vi.waitFor(() => expect(api.siteConfig).toHaveBeenCalled())
  await nextTick()
  expect(document.querySelector('a[href="/admin/audit/conversations"]')).toBeNull()
})

it('updates a name through Better Auth and refreshes sidebar identity', async () => {
  const view = await import('@/client/views/settings-account.vue')
  const update = vi.spyOn(authClient, 'updateUser').mockResolvedValue({ data: { status: true }, error: null })
  const auth = await mount(view.default)
  const refresh = vi.spyOn(auth, 'refresh').mockResolvedValue()
  await type('#account-name', 'New Name')
  document.querySelector('form[data-profile-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith(true))
  expect(update).toHaveBeenCalledWith({ name: 'New Name' })
  expect(document.querySelector('#account-email')?.hasAttribute('readonly')).toBe(true)
})

it('changes passwords while revoking other sessions and clears password fields', async () => {
  const view = await import('@/client/views/settings-account.vue')
  const change = vi.spyOn(authClient, 'changePassword').mockResolvedValue({ data: null, error: null } as never)
  const auth = await mount(view.default)
  vi.spyOn(auth, 'refresh').mockResolvedValue()
  await type('#current-password', 'old-long-password')
  await type('#new-password', 'new-long-password')
  document.querySelector('form[data-password-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(change).toHaveBeenCalledWith({ currentPassword: 'old-long-password', newPassword: 'new-long-password', revokeOtherSessions: true }))
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#new-password')!.value).toBe(''))
})

it('lets mobile users sign out from account settings', async () => {
  const view = await import('@/client/views/settings-account.vue')
  const auth = await mount(view.default)
  vi.spyOn(auth, 'signOut').mockImplementation(async () => { auth.clear() })
  expect(document.querySelector('[data-account-sign-out]')).not.toBeNull()
  document.querySelector<HTMLButtonElement>('[data-account-sign-out]')!.click()
  await vi.waitFor(() => expect(auth.authUser).toBeNull())
})

it('saves and restores registration settings then refetches public settings', async () => {
  const view = await import('@/client/views/admin-settings.vue')
  const requests: Array<{ method: string; body: unknown }> = []
  let overridden = true
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path === '/api/site-config') return Response.json({ allowRegister: overridden })
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      requests.push({ method: 'PUT', body })
      overridden = body.allowRegister !== null
    }
    return Response.json({ allowRegister: overridden, source: overridden ? 'db' : 'default' })
  })
  const publicSettings = vi.spyOn(api, 'siteConfig')
  await mount(view.default)
  await vi.waitFor(() => expect(document.querySelector('[data-save-settings]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('[data-save-settings]')!.click()
  await vi.waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(1))
  document.querySelector<HTMLButtonElement>('[data-restore-settings]')!.click()
  await vi.waitFor(() => expect(publicSettings).toHaveBeenCalledTimes(2))
  expect(requests).toEqual([{ method: 'PUT', body: { allowRegister: true } }, { method: 'PUT', body: { allowRegister: null } }])
})

it('lists accounts in pages and disables owner ban and demotion actions', async () => {
  const view = await import('@/client/views/admin-users.vue')
  vi.mocked(authClient.admin.listUsers).mockResolvedValue({ data: { users: [{ id: '1', name: 'Owner', email: 'owner@example.com', role: 'user', banned: false, createdAt: new Date(), updatedAt: new Date(), emailVerified: false }], total: 21, limit: 20, offset: 0 }, error: null })
  await mount(view.default)
  await vi.waitFor(() => expect(document.querySelector('[data-user-actions="1"]')).not.toBeNull())
  document.querySelector<HTMLElement>('[data-user-actions="1"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('[data-ban-user]')).not.toBeNull())
  expect(document.querySelector('[data-ban-user]')!.getAttribute('aria-disabled')).toBe('true')
  expect(document.querySelector('[data-set-role]')!.getAttribute('aria-disabled')).toBe('true')
  expect(document.querySelector<HTMLButtonElement>('[data-next-page]')!.disabled).toBe(false)
})

const managedUser = { id: '2', name: 'Member', email: 'member@example.com', role: 'user', banned: false, createdAt: new Date(), updatedAt: new Date(), emailVerified: false }
async function mountUsers(auditEnabled = false) {
  vi.mocked(authClient.admin.listUsers).mockResolvedValue({ data: { users: [managedUser], total: 21, limit: 20, offset: 0 }, error: null })
  const view = await import('@/client/views/admin-users.vue')
  const auth = await mount(view.default, auditEnabled)
  await vi.waitFor(() => expect(document.querySelector('[data-user-actions="2"]')).not.toBeNull())
  return auth
}
function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!
}
async function openActions() {
  document.querySelector<HTMLElement>('[data-user-actions="2"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('[data-ban-user]')).not.toBeNull())
}

it('offers the owner a read-only audit of other accounts only while audit is enabled', async () => {
  await mountUsers(true)
  await vi.waitFor(() => expect(api.siteConfig).toHaveBeenCalled())
  await openActions()
  expect(document.querySelector('[data-audit-user]')).not.toBeNull()
  cleanup()
  vi.restoreAllMocks()
  await mountUsers(false)
  await openActions()
  expect(document.querySelector('[data-audit-user]')).toBeNull()
})

it('loads the next page with an offset rather than reloading the first page', async () => {
  await mountUsers()
  document.querySelector<HTMLButtonElement>('[data-next-page]')!.click()
  await vi.waitFor(() => expect(authClient.admin.listUsers).toHaveBeenLastCalledWith({ query: { limit: 20, offset: 20, sortBy: 'id', sortDirection: 'asc' } }))
})

it('retains the displayed page and retries its successor after a pagination failure', async () => {
  await mountUsers()
  vi.mocked(authClient.admin.listUsers).mockResolvedValueOnce({ data: null, error: { status: 503, statusText: 'Unavailable', message: 'Unavailable' } } as never)
  document.querySelector<HTMLButtonElement>('[data-next-page]')!.click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('无法加载账户列表'))
  expect(document.body.textContent).toContain('第 1 页')
  expect(document.querySelector('[data-user-actions="2"]')).not.toBeNull()
  vi.mocked(authClient.admin.listUsers).mockResolvedValueOnce({ data: { users: [{ ...managedUser, id: '21', name: 'Next page user' }], total: 21, limit: 20, offset: 20 }, error: null })
  document.querySelector<HTMLButtonElement>('[data-next-page]')!.click()
  await vi.waitFor(() => expect(document.querySelector('[data-user-actions="21"]')).not.toBeNull())
  expect(document.body.textContent).toContain('第 2 页')
  expect(document.querySelector('[data-user-actions="2"]')).toBeNull()
  expect(authClient.admin.listUsers).toHaveBeenLastCalledWith({ query: { limit: 20, offset: 20, sortBy: 'id', sortDirection: 'asc' } })
})

it('creates an account and refreshes the list only after successful creation', async () => {
  await mountUsers()
  vi.mocked(authClient.admin.createUser).mockResolvedValue({ data: { user: managedUser }, error: null })
  button('创建账户').click()
  await vi.waitFor(() => expect(document.querySelector('#admin-name')).not.toBeNull())
  await type('#admin-name', 'New Member')
  await type('#admin-email', 'new@example.com')
  await type('#admin-password', 'new-long-password')
  document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(authClient.admin.listUsers).toHaveBeenCalledTimes(2))
  expect(authClient.admin.createUser).toHaveBeenCalledWith({ name: 'New Member', email: 'new@example.com', password: 'new-long-password', role: 'user' })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('requires confirmation before banning the selected account and keeps errors actionable', async () => {
  await mountUsers()
  vi.mocked(authClient.admin.banUser).mockResolvedValue({ data: null, error: { status: 403, statusText: 'Forbidden', message: 'Denied' } })
  await openActions()
  document.querySelector<HTMLElement>('[data-ban-user]')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
  expect(authClient.admin.banUser).not.toHaveBeenCalled()
  button('确认').click()
  await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"] [role="alert"]')).not.toBeNull())
  expect(authClient.admin.banUser).toHaveBeenCalledWith({ userId: '2' })
  expect(authClient.admin.listUsers).toHaveBeenCalledTimes(1)
  expect(button('确认').disabled).toBe(false)
})
