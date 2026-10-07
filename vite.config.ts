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
    cloudflare(),
  ],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  environments: {
    // The guided demo is a second page served from the same static assets at `/demo/`. Scoped to
    // the client: a top-level `build.input` also reaches the Worker build and breaks it.
    client: { build: { rolldownOptions: { input: { main: path.resolve(import.meta.dirname, 'index.html'), demo: path.resolve(import.meta.dirname, 'demo/index.html') } } } },
  },
  server: { port: 7456 },
})
