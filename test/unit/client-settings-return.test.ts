// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { expect, it } from 'vitest'
import AppShell from '@/client/components/app-shell.vue'

it('remembers the Project conversation used to enter settings across internal settings navigation', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/project/7/c/8?view=details')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(AppShell) }).use(createPinia()).use(router)
  app.mount(host)
  try {
    await router.push('/settings/providers')
    await router.push('/settings/providers/1')
    await router.push('/settings/appearance')
    await nextTick()
    const back = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '返回聊天')!
    expect(back).toBeDefined()
    back.click()
    await new Promise<void>(resolve => router.afterEach(() => resolve()))
    expect(router.currentRoute.value.fullPath).toBe('/project/7/c/8?view=details')
  } finally { app.unmount(); host.remove() }
})
