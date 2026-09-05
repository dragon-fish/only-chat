import path from 'node:path'
import { defineConfig } from 'vite'
import VueRouter from 'vue-router/vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [
    VueRouter({ routesFolder: 'src/client/pages', dts: 'src/client/typed-router.d.ts' }),
    vue(),
    tailwindcss(),
    cloudflare(),
  ],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
})
