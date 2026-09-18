// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/client/lib/api'
import { useAuthStore } from '@/client/stores/auth'
import type { AuditConversationRow } from '@/shared/api'

vi.mock('@/client/lib/auth-client', async importOriginal => ({
  ...await importOriginal<typeof import('@/client/lib/auth-client')>(),
  authClient: { getSession: vi.fn(), admin: { listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })) } },
}))

const owner = { id: 3, name: 'Member', email: 'member@example.com' }
const row: AuditConversationRow = {
  id: 7, title: 'Member chat', kind: 'chat', archived: false, created_at: 0, updated_at: 0, owner, model: null, tokens: { input: 0, output: 0 },
}

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

it('previews a conversation over the listing, with the URL carrying it and no reload of the listing', async () => {
  const list = vi.spyOn(api, 'auditConversations').mockResolvedValue({ rows: [row], next: null, prev: null })
  vi.spyOn(api, 'auditTranscript').mockResolvedValue({
    conversation: { id: 7, title: 'Member chat', head_message_id: null } as never, owner, messages: [],
    config: { project: null, systemPrompt: null, params: {}, model: null },
  })
  vi.spyOn(api, 'auditProviders').mockResolvedValue({ rows: [], next: null, prev: null })
  document.body.innerHTML = '<div id="page-header"></div><div id="host"></div>'
  const pinia = createPinia()
  useAuthStore(pinia).authUser = { id: '1', name: 'Owner', email: 'o@example.com', emailVerified: false, createdAt: new Date(), updatedAt: new Date(), banned: false }
  const view = (await import('@/client/views/admin-audit-conversations.vue')).default
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/audit/conversations', component: view }] })
  await router.push('/admin/audit/conversations?user=3')
  const app = createApp({ render: () => h(view) }).use(pinia).use(router)
  app.mount('#host')
  cleanup = () => app.unmount()

  await vi.waitFor(() => expect(document.querySelector('[data-audit-conversation="7"] a')).not.toBeNull())
  document.querySelector<HTMLAnchorElement>('[data-audit-conversation="7"] a')!.click()
  await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ user: '3', preview: '7' }))
  await vi.waitFor(() => expect(document.body.textContent).toContain('只读 · Member'))
  expect(list).toHaveBeenCalledOnce()
})
