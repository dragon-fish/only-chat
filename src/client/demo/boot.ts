import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { enableKatex } from 'markstream-vue'
import '@/client/style.css'
import '@/client/styles/main.scss'
import 'katex/dist/katex.min.css'
import App from '@/client/app.vue'
import { useTheme } from '@/client/composables/use-theme'
import { api } from '@/client/lib/api'
import { createAppRouter } from '@/client/router'
import { ClientPluginHost } from '@/client/plugins/host'
import { pluginLoaders, pluginManifests } from '@/client/plugins/loaders'
import type { DemoBackend } from './backend'
import { ATTACHMENT_URLS } from './script'
import { startTour } from './tour'

/** `main.ts` with an in-memory router, images from the demo bundle, and the tour on top. */
export async function boot(backend: DemoBackend): Promise<void> {
  enableKatex(() => import('katex'))
  useTheme()
  // `<img>` never goes through fetch, so attachment URLs must not point at `/api/` at all.
  api.attachmentUrl = id => ATTACHMENT_URLS[id] ?? ''

  const router = createAppRouter(createMemoryHistory())
  const host = new ClientPluginHost({ manifests: pluginManifests, loaders: pluginLoaders })
  const app = createApp(App)
  app.provide('clientPluginHost', host)
  app.use(createPinia()).use(router)
  await router.push('/new')
  app.mount('#app')
  startTour(router, backend)
}
