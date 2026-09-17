// @vitest-environment happy-dom
import { createApp, nextTick, shallowRef } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import App from '@/client/app.vue'
import LoginPage from '@/client/pages/login.vue'
import ProvidersPage from '@/client/pages/settings/providers/index.vue'
import ChatsPage from '@/client/pages/chats/index.vue'
import ImagesPage from '@/client/pages/images.vue'
import ImageNewPage from '@/client/pages/images/new.vue'

vi.mock('@/client/lib/auth-client', () => ({
  authClient: { useSession: () => shallowRef({ isPending: true }) },
}))
vi.mock('@/client/views/auth-login.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/client/views/settings-providers.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/client/views/chat-index.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/client/views/image-gallery.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/client/views/image-studio.vue', () => ({ default: { template: '<div />' } }))

let unmount = () => {}

afterEach(() => {
  unmount()
  document.body.innerHTML = ''
  document.title = 'Only Chat'
})

it('lets each page set its title and keeps the chat index on the brand title', async () => {
  document.title = 'Only Chat'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', component: LoginPage, meta: { guestOnly: true } },
      { path: '/settings/providers', component: ProvidersPage, meta: { guestOnly: true } },
      { path: '/chats', component: ChatsPage, meta: { guestOnly: true } },
    ],
  })
  await router.push('/login')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(App).use(createPinia()).use(router)
  app.mount(host)
  unmount = () => app.unmount()
  await nextTick()
  expect(document.title).toBe('登录 | Only Chat')

  await router.push('/settings/providers')
  await nextTick()
  expect(document.title).toBe('供应商设置 | Only Chat')

  await router.push('/chats')
  await nextTick()
  expect(document.title).toBe('Only Chat')
})

it('restores the image gallery title after leaving its nested creation page', async () => {
  document.title = 'Only Chat'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{
      path: '/images', component: ImagesPage, meta: { guestOnly: true },
      children: [{ path: 'new', component: ImageNewPage }],
    }],
  })
  await router.push('/images')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(App).use(createPinia()).use(router)
  app.mount(host)
  unmount = () => app.unmount()
  await nextTick()
  expect(document.title).toBe('图片 Gallery | Only Chat')

  await router.push('/images/new')
  await nextTick()
  expect(document.title).toBe('图片创作 | Only Chat')

  await router.push('/images')
  await nextTick()
  expect(document.title).toBe('图片 Gallery | Only Chat')
})
