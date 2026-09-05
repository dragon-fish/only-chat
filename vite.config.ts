import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [vue(), tailwindcss(), cloudflare()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
})
