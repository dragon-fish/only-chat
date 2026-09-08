import type { D1Migration } from '@cloudflare/vitest-plugin'

declare global {
  namespace Cloudflare {
    interface Env {
      KV: KVNamespace
      TEST_MIGRATIONS: D1Migration[]
      TEST_LEGACY_DB: D1Database
    }
  }
}
export {}
