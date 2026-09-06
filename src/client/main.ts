import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { enableKatex } from 'markstream-vue'
import './style.css'
import './styles/main.scss'
import 'katex/dist/katex.min.css'
import App from './app.vue'
import { useTheme } from './composables/use-theme'
import { router } from './router'

enableKatex(() => import('katex'))
useTheme()

createApp(App).use(createPinia()).use(router).mount('#app')
