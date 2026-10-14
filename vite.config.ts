import path from 'node:path'
import { defineConfig } from 'vite'
import VueRouter from 'vue-router/vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [
    VueRouter({
      routesFolder: 'src/client/pages',
      dts: 'src/client/typed-router.d.ts',
    }),
    vue(),
    tailwindcss(),
    // Containers need Docker to build their image, so local dev leaves them off unless asked.
    cloudflare({ config: config => (process.env.SANDBOX_DEV === '1' ? {} : { dev: { ...config.dev, enable_containers: false } }) }),
  ],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { port: 7456 },
})
