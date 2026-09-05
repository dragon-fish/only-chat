import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
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
        resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
    ],
  },
})
