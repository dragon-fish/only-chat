import path from 'node:path'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import VueRouter from 'vue-router/vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

/**
 * One id for the page and the Worker built together, so a page can tell it outlived a deploy. Workers
 * Builds names the commit; a local build asks git; the dev server is always 'dev' and never compared.
 */
function buildVersion(command: 'build' | 'serve'): string {
  if (command === 'serve') return 'dev'
  if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig(({ command }) => ({
  define: { 'import.meta.env.BUILD_VERSION': JSON.stringify(buildVersion(command)) },
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
}))
