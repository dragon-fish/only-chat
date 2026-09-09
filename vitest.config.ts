import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import vue from '@vitejs/plugin-vue'
import VueRouter from 'vue-router/vite'

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              d1Databases: ['DB', 'TEST_LEGACY_DB'],
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
                KEY_ENCRYPTION_SECRET: 'test-secret-do-not-use-in-prod',
              },
            },
          })),
        ],
        resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          setupFiles: ['./test/worker/apply-migrations.ts'],
        },
      },
      {
        plugins: [VueRouter({ routesFolder: 'src/client/pages', dts: 'src/client/typed-router.d.ts' }), vue()],
        resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          setupFiles: ['./test/unit/setup.ts'],
        },
      },
    ],
  },
})
