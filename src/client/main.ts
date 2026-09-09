import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { enableKatex } from 'markstream-vue'
import './style.css'
import './styles/main.scss'
import 'katex/dist/katex.min.css'
import App from './app.vue'
import { useTheme } from './composables/use-theme'
import { redirectAfterUnauthorized, router } from './router'
import { setUnauthorizedHandler } from './lib/api'
import { ClientPluginHost } from './plugins/host'
import { pluginLoaders, pluginManifests } from './plugins/loaders'

enableKatex(() => import('katex'))
useTheme()

export const clientPluginHost = new ClientPluginHost({ manifests: pluginManifests, loaders: pluginLoaders })
setUnauthorizedHandler(() => redirectAfterUnauthorized(router))

const app = createApp(App)
app.provide('clientPluginHost', clientPluginHost)
app.use(createPinia()).use(router).mount('#app')

if (import.meta.hot) import.meta.hot.dispose(() => clientPluginHost.dispose())
