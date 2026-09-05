# only-chat MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare-hosted personal AI chat web app where every device sees the same sessions, messages and in-progress streams in real time, with four provider protocols and image attachments.

**Architecture:** One Worker (Hono REST + static Vue SPA) plus one `UserHub` Durable Object per user that owns every WebSocket of that user, runs LLM generation via Vercel AI SDK, writes results to D1 and broadcasts events. cordis 4 is the backend skeleton (services, plugins, events); Drizzle talks to D1; R2 stores images. The frontend is Vue 3 + Pinia with a single sync store applying DO events idempotently.

**Tech Stack:** Cloudflare Workers / DO / D1 / R2, `@cloudflare/vite-plugin`, Hono 4, cordis 4.0.0-rc.9, Drizzle ORM 0.45 + drizzle-kit 0.31, Vercel AI SDK 7 (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google-vertex`, `@ai-sdk/openai-compatible`), zod 4, Vue 3.5, vue-router 5, Pinia 4, shadcn-vue 2 + Tailwind 4, markstream-vue 2, Vitest 4.1 + `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-09-05-only-chat-mvp-design.md` — read it first; this plan argues from it.

**Research notes (verified 2026-09-05, read the one relevant to your task before coding):**
- cordis v4 API: `C:\Users\xiaoy\AppData\Local\Temp\claude\E-------\090239f0-895a-49c5-9f1f-2ccabf2deaa3\scratchpad\research\cordis\findings.md`
- Vercel AI SDK 7: `...\scratchpad\research\aisdk\findings.md`
- Cloudflare vite-plugin / DO / vitest-plugin / D1 CLI: `...\scratchpad\research\cf\findings.md` (a working scaffold lives in `...\scratchpad\research\cf`)
- Drizzle D1 / markstream-vue / shadcn-vue / pug / pinia / zod: `...\scratchpad\research\libs\findings.md`

If the scratchpad is gone, the facts you need are repeated inline in each task; do not go back to memory or web search for API shapes — install the package and read its `.d.ts`.

## Global Constraints

- Single package, pnpm, ESM only. Repo root: `E:\GitRepositories\only-chat`, branch `feat/mvp`.
- Node 24 on Windows 11. Shell commands in this plan are Git Bash syntax; network commands need `https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897` prefixed, and the shadcn CLI additionally needs `NODE_OPTIONS=--use-env-proxy`.
- The Vite dev server on Windows binds IPv6 only: use `http://localhost:5173`, never `127.0.0.1`.
- Version locks (exact): `typescript` **5.9.3**, `vitest` **4.1.11** (+ `@vitest/runner`, `@vitest/snapshot` 4.1.11), `cordis` **4.0.0-rc.9**. Caret ranges: `drizzle-orm ^0.45.2`, `drizzle-kit ^0.31.10` (never the 1.0 RC), everything else per Task 1.
- The user's global pnpm has a `minimumReleaseAge` policy. If `pnpm add` rejects a version, let pnpm pick an older one inside the caret range; do not add `minimum-release-age=0` to the project.
- `user_id` is hard-coded to `1` everywhere (`DEFAULT_USER_ID` in `src/shared/constants.ts`). No auth in MVP.
- All timestamps are epoch milliseconds stored as SQLite integers and transported as JSON numbers. No `Date` objects cross module boundaries.
- Drizzle column property names are the snake_case column names themselves (`head_message_id: integer()`), so DB rows are the wire DTOs without a mapping layer. Do not set `casing`.
- cordis rules: no ES `#private` fields in any class cordis touches (use `_prefixed`); plugins access services only after declaring them in `inject`; every plugin registers its side effects through the `ctx` handed to it; use `ctx.get('x')` for optional lookups; `await ctx.plugin(...)` before using a service.
- Prefix-cache invariant: `buildModelMessages` is a pure function; nothing request-specific goes into messages; reasoning `providerOptions` are stored and replayed verbatim; `openai-completions` drops reasoning parts; OpenAI responses uses `store: false`.
- The LLM stream is consumed inside the `webSocketMessage` event that triggered it (awaited). Never fire-and-forget in the DO; `waitUntil` is a no-op there.
- Commits: Conventional Commits in English, one focused commit per task, with the trailer lines
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SsUSUCkrGW5vaFdk4KUPVG`. Do not push.
- Tests: run only the tests relevant to the task (`pnpm vitest run <path>`); the full suite runs once at the end of the plan.
- Code comments in English. UI copy in Simplified Chinese.

---

## File Structure

```
only-chat/
├─ package.json, pnpm-lock.yaml, .npmrc, .gitignore, .dev.vars.example
├─ index.html                          Vite entry → /src/client/main.ts
├─ vite.config.ts                      vue + tailwind + cloudflare plugins, alias @ → src
├─ vitest.config.ts                    projects: worker (workerd) + unit (node)
├─ wrangler.jsonc                      Worker + DO + D1 + R2 + assets config
├─ drizzle.config.ts                   dialect sqlite, out ./migrations
├─ tsconfig.json                       references only
├─ tsconfig.app.json                   client + shared (DOM lib, vite/client)
├─ tsconfig.worker.json                server + shared (worker-configuration.d.ts)
├─ worker-configuration.d.ts           generated by `wrangler types` (committed)
├─ components.json                     shadcn-vue, aliases.ui = @/client/ui
├─ migrations/                         drizzle-kit output (0000_init.sql + meta/)
├─ src/
│  ├─ shared/
│  │  ├─ constants.ts                  DEFAULT_USER_ID, limits
│  │  ├─ parts.ts                      Part union + zod schema
│  │  ├─ models.ts                     Session/Message/Provider/Model/Attachment/UserSettings DTOs + zod
│  │  ├─ ws.ts                         WsCommand / WsEvent zod unions
│  │  └─ api.ts                        REST request/response DTOs
│  ├─ server/
│  │  ├─ index.ts                      Worker entry (Hono fetch) + `export class UserHub`
│  │  ├─ app.ts                        createApp(env, side, doState?) → cordis Context
│  │  ├─ db/schema.ts                  Drizzle schema
│  │  ├─ db/client.ts                  drizzle(env.DB, { schema }) + DB type
│  │  └─ plugins/
│  │     ├─ database.ts                Database service (ctx.db) + ensureDefaultUser
│  │     ├─ assets.ts                  Assets service (ctx.assets) over R2
│  │     ├─ llm/
│  │     │  ├─ index.ts                Llm service (registry, createModel) + loads protocol plugins
│  │     │  ├─ crypto.ts               AES-GCM encrypt/decrypt of API keys
│  │     │  ├─ messages.ts             buildModelMessages (pure) + provider options
│  │     │  ├─ accumulator.ts          PartAccumulator: AI SDK stream parts → our parts + events
│  │     │  ├─ usage.ts                LanguageModelUsage → Usage
│  │     │  ├─ presets.ts              preset provider templates
│  │     │  ├─ list-models.ts          GET /models for a provider row
│  │     │  └─ protocols/{openai-completions,openai-responses,anthropic,vertex}.ts
│  │     ├─ hub/
│  │     │  ├─ index.ts                Hub service: sockets, broadcast, command dispatch
│  │     │  ├─ seq.ts                  SeqAllocator
│  │     │  ├─ tree.ts                 pathToRoot, siblingsOf (pure)
│  │     │  ├─ sessions.ts             session/message D1 operations used by hub
│  │     │  └─ generation.ts           runGeneration pipeline
│  │     └─ api/
│  │        ├─ index.ts                Api plugin: builds Hono app, exposes ctx.api
│  │        ├─ sessions.ts, providers.ts, models.ts, attachments.ts, me.ts
│  └─ client/
│     ├─ main.ts, app.vue, router.ts, style.css, styles/main.scss
│     ├─ lib/{api.ts, ws-client.ts, image-prep.ts, utils.ts}
│     ├─ stores/{sync.ts, config.ts}
│     ├─ views/{chat.vue, settings-providers.vue, settings-provider-edit.vue, settings-plugins.vue}
│     ├─ components/{app-shell.vue, session-list.vue, message-list.vue, message-item.vue, branch-switcher.vue, composer.vue, model-picker.vue}
│     └─ ui/                           shadcn-vue generated
└─ test/
   ├─ tsconfig.json, env.d.ts
   ├─ worker/apply-migrations.ts       setup: applyD1Migrations
   ├─ worker/*.test.ts                 workerd tests (DO, D1, R2, REST)
   └─ unit/*.test.ts                   node tests (shared, llm pure functions, client stores)
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.npmrc`, `.gitignore` (modify), `.dev.vars.example`, `index.html`, `vite.config.ts`, `vitest.config.ts`, `wrangler.jsonc`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.worker.json`, `src/shared/constants.ts`, `src/server/index.ts`, `src/client/main.ts`, `src/client/app.vue`, `src/client/style.css`, `test/tsconfig.json`, `test/env.d.ts`, `test/worker/apply-migrations.ts`, `test/worker/smoke.test.ts`, `test/unit/smoke.test.ts`, `migrations/.gitkeep`

**Interfaces:**
- Produces: `Env` bindings `DB: D1Database`, `BUCKET: R2Bucket`, `USER_HUB: DurableObjectNamespace<UserHub>`, `ASSETS: Fetcher`, secret `KEY_ENCRYPTION_SECRET: string` (from `worker-configuration.d.ts`); scripts `dev`, `build`, `typecheck`, `test`, `types`, `db:generate`, `db:migrate:local`, `db:migrate:remote`.

- [ ] **Step 1: package.json and pnpm config**

```json
{
  "name": "only-chat",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.25.0",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "deploy": "pnpm build && wrangler deploy",
    "types": "wrangler types",
    "typecheck": "vue-tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.worker.json --noEmit && tsc -p test/tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 migrations apply only-chat-db --local",
    "db:migrate:remote": "wrangler d1 migrations apply only-chat-db --remote"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^4.0.49",
    "@ai-sdk/google-vertex": "^5.0.75",
    "@ai-sdk/openai": "^4.0.58",
    "@ai-sdk/openai-compatible": "^3.0.43",
    "@ai-sdk/provider-utils": "^5.0.36",
    "@lucide/vue": "^1.41.0",
    "@vue/devtools-api": "^8.2.1",
    "ai": "^7.0.92",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "cordis": "4.0.0-rc.9",
    "drizzle-orm": "^0.45.2",
    "hono": "^4.13.5",
    "katex": "^0.18.5",
    "markstream-vue": "^2.0.8",
    "pinia": "^4.0.3",
    "reka-ui": "^2.10.4",
    "shadcn-vue": "^2.8.2",
    "stream-diffs": "^0.0.2",
    "tailwind-merge": "^3.6.0",
    "tailwindcss": "^4.3.3",
    "tw-animate-css": "^1.4.0",
    "vue": "^3.5.42",
    "vue-router": "^5.3.1",
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.54.4",
    "@cloudflare/vitest-plugin": "^1.1.4",
    "@tailwindcss/vite": "^4.3.3",
    "@types/node": "^24.13.3",
    "@vitejs/plugin-vue": "^6.0.8",
    "@vitest/runner": "4.1.11",
    "@vitest/snapshot": "4.1.11",
    "@vue/tsconfig": "^0.8.1",
    "drizzle-kit": "^0.31.10",
    "pug": "^3.0.4",
    "sass-embedded": "^1.104.0",
    "typescript": "5.9.3",
    "vite": "^8.2.2",
    "vitest": "4.1.11",
    "vue-tsc": "^3.3.11",
    "wrangler": "^4.129.0"
  }
}
```

`.npmrc`:
```
virtual-store-dir-max-length=120
```

Append to `.gitignore`:
```
.dev.vars*
!.dev.vars.example
.wrangler/
node_modules/.tmp/
```
(`worker-configuration.d.ts` is committed on purpose so typecheck works on a fresh clone.)

`.dev.vars.example`:
```
KEY_ENCRYPTION_SECRET="change-me-32-bytes-of-randomness"
```

- [ ] **Step 2: install**

Run: `https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 pnpm install`
Expected: lockfile written, no peer warnings about zod or vitest. If `pnpm-workspace.yaml` appears, delete it (single package).

- [ ] **Step 3: wrangler.jsonc, vite, vitest, tsconfigs**

`wrangler.jsonc`:
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "only-chat",
  "main": "./src/server/index.ts",
  "compatibility_date": "2026-09-05",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/ws"]
  },
  "durable_objects": {
    "bindings": [{ "name": "USER_HUB", "class_name": "UserHub" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UserHub"] }],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "only-chat-db",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "only-chat-attachments" }]
}
```
(The placeholder `database_id` works locally. The real id is filled in when the user runs `wrangler d1 create only-chat-db` before first deploy.)

`vite.config.ts`:
```ts
import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [vue(), tailwindcss(), cloudflare()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
})
```

`vitest.config.ts`:
```ts
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
```

`tsconfig.json` (the `paths` entry is only there so the shadcn-vue CLI can resolve the `@` alias):
```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.worker.json" }],
  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }
}
```

`tsconfig.app.json`:
```json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "compilerOptions": {
    "composite": true,
    "paths": { "@/*": ["./src/*"] },
    "types": ["vite/client"],
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/client/**/*.ts", "src/client/**/*.vue", "src/shared/**/*.ts"]
}
```

`tsconfig.worker.json`:
```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": { "@/*": ["./src/*"] },
    "types": ["@types/node", "./worker-configuration.d.ts"],
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.worker.tsbuildinfo"
  },
  "include": ["src/server/**/*.ts", "src/shared/**/*.ts", "vite.config.ts", "vitest.config.ts", "drizzle.config.ts", "worker-configuration.d.ts"]
}
```

`test/tsconfig.json`:
```json
{
  "extends": "../tsconfig.worker.json",
  "compilerOptions": {
    "composite": false,
    "paths": { "@/*": ["../src/*"] },
    "types": ["@cloudflare/vitest-plugin/types", "./env.d.ts", "../worker-configuration.d.ts"],
    "tsBuildInfoFile": "../node_modules/.tmp/tsconfig.test.tsbuildinfo"
  },
  "include": ["./**/*.ts", "../src/**/*.ts", "../worker-configuration.d.ts"]
}
```

`test/env.d.ts`:
```ts
import type { D1Migration } from '@cloudflare/vitest-plugin'

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
export {}
```

- [ ] **Step 4: minimal Worker, DO and client**

`src/shared/constants.ts`:
```ts
export const DEFAULT_USER_ID = 1
export const MAX_IMAGE_EDGE = 2048
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000
export const INFLIGHT_FLUSH_INTERVAL_MS = 1000
```

`src/server/index.ts` (placeholder; replaced in Task 10/12):
```ts
import { Hono } from 'hono'
import { DurableObject } from 'cloudflare:workers'

const app = new Hono<{ Bindings: Env }>()
app.get('/api/health', (c) => c.json({ ok: true }))

export default { fetch: app.fetch } satisfies ExportedHandler<Env>

export class UserHub extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}
```

`index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>only-chat</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/client/main.ts"></script>
  </body>
</html>
```

`src/client/style.css`:
```css
@import "tailwindcss";
```

`src/client/main.ts`:
```ts
import { createApp } from 'vue'
import './style.css'
import App from './app.vue'

createApp(App).mount('#app')
```

`src/client/app.vue`:
```vue
<script setup lang="ts">
const title = 'only-chat'
</script>

<template lang="pug">
main.p-4
  h1.text-xl.font-bold {{ title }}
</template>
```

`test/worker/apply-migrations.ts`:
```ts
import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll } from 'vitest'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
```

`test/worker/smoke.test.ts`:
```ts
import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('worker smoke', () => {
  it('answers /api/health', async () => {
    const res = await exports.default.fetch(new Request('https://x/api/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
```

`test/unit/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_USER_ID } from '@/shared/constants'

describe('unit smoke', () => {
  it('has the default user id', () => {
    expect(DEFAULT_USER_ID).toBe(1)
  })
})
```

Create an empty `migrations/.gitkeep` so `readD1Migrations` finds the directory.

- [ ] **Step 5: generate types, typecheck, run tests**

Run: `pnpm types`
Expected: `worker-configuration.d.ts` created with `DB`, `BUCKET`, `USER_HUB`, `ASSETS` in `Env`. Copy `.dev.vars.example` to `.dev.vars` first so `KEY_ENCRYPTION_SECRET: string` is included.

Run: `pnpm typecheck`
Expected: exit 0.

Run: `pnpm test`
Expected: 2 files, 2 tests passed (worker + unit projects).

Run: `pnpm dev` in the background, then `curl http://localhost:5173/api/health` and `curl -s http://localhost:5173/ | head -3`
Expected: `{"ok":true}` and the HTML shell. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold vite + cloudflare worker + vitest projects"
```

---

### Task 2: Shared parts, usage, and domain DTOs

**Files:**
- Create: `src/shared/parts.ts`, `src/shared/models.ts`
- Test: `test/unit/shared-parts.test.ts`, `test/unit/shared-models.test.ts`

**Interfaces:**
- Produces:
  - `parts.ts`: `Part`, `TextPart`, `ImagePart`, `ReasoningPart`, `ToolCallPart`, `ToolResultPart`, `PartSchema`, `PartsSchema`, `ProviderOptions = Record<string, Record<string, unknown>>`.
  - `models.ts`: `Protocol` (`'openai-completions' | 'openai-responses' | 'anthropic' | 'vertex'`), `ProtocolSchema`, `Usage`, `UsageSchema`, `MessageStatus` (`'streaming' | 'done' | 'error' | 'aborted'`), `SessionParams`, `SessionParamsSchema`, `ModelCapabilities`, `ModelPricing`, `UserSettings`, `UserSettingsSchema`, DTO interfaces `Session`, `Message`, `Provider` (no key), `Model`, `Attachment`, `User`, and their zod schemas `SessionSchema`, `MessageSchema`, `ProviderSchema`, `ModelSchema`, `AttachmentSchema`.

- [ ] **Step 1: Write failing tests**

`test/unit/shared-parts.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PartSchema, PartsSchema, type Part } from '@/shared/parts'

describe('PartSchema', () => {
  it('round-trips every part type', () => {
    const parts: Part[] = [
      { type: 'text', text: 'hi' },
      { type: 'image', attachment_id: 7 },
      { type: 'reasoning', text: 'thinking', providerOptions: { anthropic: { signature: 'SIG' } } },
      { type: 'tool_call', id: 'c1', name: 'get_weather', args: { city: 'Tokyo' } },
      { type: 'tool_result', call_id: 'c1', name: 'get_weather', content: { tempC: 21 } },
    ]
    expect(PartsSchema.parse(JSON.parse(JSON.stringify(parts)))).toEqual(parts)
  })

  it('rejects unknown part types', () => {
    expect(PartSchema.safeParse({ type: 'video', url: 'x' }).success).toBe(false)
  })

  it('keeps reasoning providerOptions optional', () => {
    expect(PartSchema.parse({ type: 'reasoning', text: '' })).toEqual({ type: 'reasoning', text: '' })
  })
})
```

`test/unit/shared-models.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MessageSchema, ProviderSchema, SessionParamsSchema, UsageSchema, UserSettingsSchema } from '@/shared/models'

describe('models schemas', () => {
  it('distinguishes undefined and 0 in usage', () => {
    const u = UsageSchema.parse({ prompt: 10, completion: 0 })
    expect(u.completion).toBe(0)
    expect(u.cached).toBeUndefined()
  })

  it('parses a streaming message with null parent', () => {
    const m = MessageSchema.parse({
      id: 1, session_id: 1, parent_id: null, seq: 1, role: 'assistant', parts: [],
      provider_id: 2, model_id: 'gpt-5.1', usage: null, status: 'streaming', error: null, created_at: 0,
    })
    expect(m.parent_id).toBeNull()
  })

  it('never carries an api key on Provider DTOs', () => {
    expect(ProviderSchema.safeParse({
      id: 1, user_id: 1, name: 'x', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1',
      has_key: true, extra: null, enabled: true, created_at: 0, api_key: 'leak',
    }).success).toBe(false)
  })

  it('defaults settings.plugins to an empty map', () => {
    expect(UserSettingsSchema.parse({})).toEqual({ plugins: {} })
  })

  it('accepts partial session params', () => {
    expect(SessionParamsSchema.parse({ temperature: 0.7 })).toEqual({ temperature: 0.7 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/shared-parts.test.ts test/unit/shared-models.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/shared/parts.ts`:
```ts
import { z } from 'zod'

export const ProviderOptionsSchema = z.record(z.string(), z.record(z.string(), z.unknown()))
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>

export const TextPartSchema = z.object({ type: z.literal('text'), text: z.string() })
export const ImagePartSchema = z.object({ type: z.literal('image'), attachment_id: z.number().int() })
export const ReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  providerOptions: ProviderOptionsSchema.optional(),
})
export const ToolCallPartSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
})
export const ToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  call_id: z.string(),
  name: z.string(),
  content: z.unknown(),
})

export const PartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImagePartSchema,
  ReasoningPartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
])
export const PartsSchema = z.array(PartSchema)

export type TextPart = z.infer<typeof TextPartSchema>
export type ImagePart = z.infer<typeof ImagePartSchema>
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>
export type Part = z.infer<typeof PartSchema>
```

`src/shared/models.ts`:
```ts
import { z } from 'zod'
import { PartsSchema } from './parts'

export const ProtocolSchema = z.enum(['openai-completions', 'openai-responses', 'anthropic', 'vertex'])
export type Protocol = z.infer<typeof ProtocolSchema>

/** undefined = provider did not report; 0 = reported zero. Never collapse the two. */
export const UsageSchema = z.object({
  prompt: z.number().optional(),
  completion: z.number().optional(),
  cached: z.number().optional(),
  reasoning: z.number().optional(),
})
export type Usage = z.infer<typeof UsageSchema>

export const MessageStatusSchema = z.enum(['streaming', 'done', 'error', 'aborted'])
export type MessageStatus = z.infer<typeof MessageStatusSchema>
export const PersistedStatusSchema = z.enum(['done', 'error', 'aborted'])
export type PersistedStatus = z.infer<typeof PersistedStatusSchema>

export const SessionParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
})
export type SessionParams = z.infer<typeof SessionParamsSchema>

export const ModelCapabilitiesSchema = z.object({
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tools: z.boolean().optional(),
})
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>

export const ModelPricingSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cached: z.number().optional(),
})
export type ModelPricing = z.infer<typeof ModelPricingSchema>

export const UserSettingsSchema = z.object({
  plugins: z.record(z.string(), z.boolean()).default({}),
})
export type UserSettings = z.infer<typeof UserSettingsSchema>

export const UserSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  settings: UserSettingsSchema,
  created_at: z.number(),
})
export type User = z.infer<typeof UserSchema>

export const SessionSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  title: z.string(),
  head_message_id: z.number().int().nullable(),
  provider_id: z.number().int().nullable(),
  model_id: z.string().nullable(),
  system_prompt: z.string().nullable(),
  params: SessionParamsSchema.nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  archived_at: z.number().nullable(),
})
export type Session = z.infer<typeof SessionSchema>

export const MessageSchema = z.object({
  id: z.number().int(),
  session_id: z.number().int(),
  parent_id: z.number().int().nullable(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  parts: PartsSchema,
  provider_id: z.number().int().nullable(),
  model_id: z.string().nullable(),
  usage: UsageSchema.nullable(),
  status: MessageStatusSchema,
  error: z.string().nullable(),
  created_at: z.number(),
})
export type Message = z.infer<typeof MessageSchema>

/** Wire DTO: the encrypted key never leaves the server; `has_key` says whether one is stored. */
export const ProviderSchema = z.strictObject({
  id: z.number().int(),
  user_id: z.number().int(),
  name: z.string(),
  protocol: ProtocolSchema,
  base_url: z.string(),
  has_key: z.boolean(),
  extra: z.record(z.string(), z.unknown()).nullable(),
  enabled: z.boolean(),
  created_at: z.number(),
})
export type Provider = z.infer<typeof ProviderSchema>

export const ModelSchema = z.object({
  id: z.number().int(),
  provider_id: z.number().int(),
  model_id: z.string(),
  display_name: z.string(),
  capabilities: ModelCapabilitiesSchema,
  pricing: ModelPricingSchema.nullable(),
  enabled: z.boolean(),
  sort: z.number().int(),
})
export type Model = z.infer<typeof ModelSchema>

export const AttachmentSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  sha256: z.string(),
  mime: z.string(),
  size: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  origin: z.enum(['upload', 'generated']),
  created_at: z.number(),
})
export type Attachment = z.infer<typeof AttachmentSchema>
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/shared-parts.test.ts test/unit/shared-models.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared test/unit
git commit -m "feat(shared): parts, usage and domain DTO schemas"
```

---

### Task 3: Shared WebSocket protocol and REST DTOs

**Files:**
- Create: `src/shared/ws.ts`, `src/shared/api.ts`
- Test: `test/unit/shared-ws.test.ts`

**Interfaces:**
- Produces:
  - `ws.ts`: `WsCommandSchema` / `WsCommand` (union by `type`: `send`, `regenerate`, `edit`, `stop`, `switch_head`, `session.update`, `session.delete`, `settings.update`), `WsEventSchema` / `WsEvent` (`snapshot`, `session.created`, `session.updated`, `session.deleted`, `message.created`, `message.delta`, `message.part`, `message.done`, `head.changed`, `settings.updated`, `error`), `parseCommand(raw: string): WsCommand` (throws `ZodError`), `encodeEvent(e: WsEvent): string`.
  - `api.ts`: `ModelRef`, `ProviderInput`, `ProviderInputSchema` (`name, protocol, base_url, api_key?, extra?, enabled?`), `ModelInput`, `ModelInputSchema`, `AttachmentCheckRequest/Response`, `AttachmentUploadResponse`, `FetchModelsResponse`.

- [ ] **Step 1: Write failing tests**

`test/unit/shared-ws.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { encodeEvent, parseCommand, WsEventSchema } from '@/shared/ws'

describe('ws protocol', () => {
  it('parses a send command with a new session', () => {
    const cmd = parseCommand(JSON.stringify({
      type: 'send', request_id: 'r1', session_id: null, parent_id: null,
      parts: [{ type: 'text', text: 'hi' }], provider_id: 1, model_id: 'gpt-5.1',
    }))
    expect(cmd.type).toBe('send')
    if (cmd.type === 'send') expect(cmd.session_id).toBeNull()
  })

  it('rejects a command without type', () => {
    expect(() => parseCommand('{"session_id":1}')).toThrow()
  })

  it('round-trips a delta event', () => {
    const raw = encodeEvent({ type: 'message.delta', message_id: 5, part_index: 0, kind: 'text', delta: 'he' })
    expect(WsEventSchema.parse(JSON.parse(raw))).toEqual({
      type: 'message.delta', message_id: 5, part_index: 0, kind: 'text', delta: 'he',
    })
  })

  it('settings.update accepts a partial plugins map', () => {
    const cmd = parseCommand(JSON.stringify({ type: 'settings.update', settings: { plugins: { foo: true } } }))
    expect(cmd.type).toBe('settings.update')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/shared-ws.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/shared/ws.ts`:
```ts
import { z } from 'zod'
import { PartSchema, PartsSchema } from './parts'
import {
  MessageSchema, MessageStatusSchema, PersistedStatusSchema, SessionParamsSchema, SessionSchema,
  UsageSchema, UserSettingsSchema,
} from './models'

const base = { request_id: z.string().optional() }

export const SendCommandSchema = z.object({
  type: z.literal('send'),
  ...base,
  session_id: z.number().int().nullable(),
  parent_id: z.number().int().nullable(),
  parts: PartsSchema.min(1),
  provider_id: z.number().int(),
  model_id: z.string().min(1),
})
export const RegenerateCommandSchema = z.object({
  type: z.literal('regenerate'),
  ...base,
  message_id: z.number().int(),
  provider_id: z.number().int().optional(),
  model_id: z.string().min(1).optional(),
})
export const EditCommandSchema = z.object({
  type: z.literal('edit'),
  ...base,
  message_id: z.number().int(),
  parts: PartsSchema.min(1),
})
export const StopCommandSchema = z.object({ type: z.literal('stop'), ...base, session_id: z.number().int() })
export const SwitchHeadCommandSchema = z.object({
  type: z.literal('switch_head'),
  ...base,
  session_id: z.number().int(),
  message_id: z.number().int(),
})
export const SessionUpdateCommandSchema = z.object({
  type: z.literal('session.update'),
  ...base,
  session_id: z.number().int(),
  title: z.string().min(1).max(200).optional(),
  provider_id: z.number().int().nullable().optional(),
  model_id: z.string().nullable().optional(),
  system_prompt: z.string().nullable().optional(),
  params: SessionParamsSchema.nullable().optional(),
})
export const SessionDeleteCommandSchema = z.object({
  type: z.literal('session.delete'),
  ...base,
  session_id: z.number().int(),
})
export const SettingsUpdateCommandSchema = z.object({
  type: z.literal('settings.update'),
  ...base,
  settings: z.object({ plugins: z.record(z.string(), z.boolean()).optional() }),
})

export const WsCommandSchema = z.discriminatedUnion('type', [
  SendCommandSchema,
  RegenerateCommandSchema,
  EditCommandSchema,
  StopCommandSchema,
  SwitchHeadCommandSchema,
  SessionUpdateCommandSchema,
  SessionDeleteCommandSchema,
  SettingsUpdateCommandSchema,
])
export type WsCommand = z.infer<typeof WsCommandSchema>
export type SendCommand = z.infer<typeof SendCommandSchema>

export const WsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), inflight: z.array(MessageSchema) }),
  z.object({ type: z.literal('session.created'), session: SessionSchema }),
  z.object({ type: z.literal('session.updated'), session: SessionSchema }),
  z.object({ type: z.literal('session.deleted'), session_id: z.number().int() }),
  z.object({ type: z.literal('message.created'), message: MessageSchema }),
  z.object({
    type: z.literal('message.delta'),
    message_id: z.number().int(),
    part_index: z.number().int(),
    kind: z.enum(['text', 'reasoning']),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('message.part'),
    message_id: z.number().int(),
    part_index: z.number().int(),
    part: PartSchema,
  }),
  z.object({
    type: z.literal('message.done'),
    message_id: z.number().int(),
    status: PersistedStatusSchema,
    usage: UsageSchema.nullable(),
    error: z.string().nullable(),
  }),
  z.object({ type: z.literal('head.changed'), session_id: z.number().int(), message_id: z.number().int() }),
  z.object({ type: z.literal('settings.updated'), settings: UserSettingsSchema }),
  z.object({ type: z.literal('error'), request_id: z.string().optional(), message: z.string() }),
])
export type WsEvent = z.infer<typeof WsEventSchema>
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export function parseCommand(raw: string): WsCommand {
  return WsCommandSchema.parse(JSON.parse(raw))
}

export function encodeEvent(event: WsEvent): string {
  return JSON.stringify(event)
}
```

`src/shared/api.ts`:
```ts
import { z } from 'zod'
import { ModelCapabilitiesSchema, ModelPricingSchema, ProtocolSchema } from './models'

export interface ModelRef {
  provider_id: number
  model_id: string
}

export const ProviderInputSchema = z.object({
  name: z.string().min(1).max(100),
  protocol: ProtocolSchema,
  base_url: z.string().url(),
  /** Plaintext key on input only; stored encrypted. Omit to keep the existing key. */
  api_key: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
})
export type ProviderInput = z.infer<typeof ProviderInputSchema>

export const ModelInputSchema = z.object({
  model_id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  pricing: ModelPricingSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  sort: z.number().int().optional(),
})
export type ModelInput = z.infer<typeof ModelInputSchema>

export const AttachmentCheckRequestSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
export type AttachmentCheckRequest = z.infer<typeof AttachmentCheckRequestSchema>
export interface AttachmentCheckResponse {
  exists: boolean
  attachment_id?: number
}
export interface AttachmentUploadResponse {
  attachment_id: number
}
export interface FetchModelsResponse {
  imported: number
  models: string[]
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/shared-ws.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared test/unit/shared-ws.test.ts
git commit -m "feat(shared): websocket command/event schemas and REST DTOs"
```

---
### Task 4: Drizzle schema, migration, D1 smoke test

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/client.ts`, `drizzle.config.ts`, `migrations/0000_init.sql` (+ `migrations/meta/*`, generated)
- Test: `test/worker/db.test.ts`

**Interfaces:**
- Produces: tables `users`, `providers`, `models`, `sessions`, `messages`, `attachments` exported from `schema.ts`; row types `UserRow`, `ProviderRow` (includes encrypted `api_key: string | null`), `ModelRow`, `SessionRow`, `MessageRow`, `AttachmentRow` (`typeof table.$inferSelect`); `createDb(d1: D1Database): DB` and `type DB` from `client.ts`.

- [ ] **Step 1: Write the failing test**

`test/worker/db.test.ts`:
```ts
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { messages, sessions, users } from '@/server/db/schema'

describe('D1 schema', () => {
  it('inserts a session and a message tree', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [s] = await db.insert(sessions).values({
      user_id: 1, title: 't', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    const [u] = await db.insert(messages).values({
      session_id: s!.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hi' }],
      provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 2,
    }).returning()
    const [a] = await db.insert(messages).values({
      session_id: s!.id, parent_id: u!.id, seq: 2, role: 'assistant', parts: [],
      provider_id: null, model_id: 'm', usage: { prompt: 1, completion: 0 }, status: 'error', error: null, created_at: 3,
    }).returning()
    const rows = await db.select().from(messages).where(eq(messages.session_id, s!.id)).orderBy(messages.seq)
    expect(rows.map((r) => r.id)).toEqual([u!.id, a!.id])
    expect(rows[1]!.usage).toEqual({ prompt: 1, completion: 0 })
    expect(rows[0]!.parts).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('enforces unique (session_id, seq)', async () => {
    const db = createDb(env.DB)
    const [s] = await db.insert(sessions).values({
      user_id: 1, title: 't2', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    const row = {
      session_id: s!.id, parent_id: null, seq: 1, role: 'user' as const, parts: [],
      provider_id: null, model_id: null, usage: null, status: 'done' as const, error: null, created_at: 0,
    }
    await db.insert(messages).values(row)
    await expect(db.insert(messages).values(row)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/worker/db.test.ts`
Expected: FAIL (module not found / no tables).

- [ ] **Step 3: Schema and client**

`src/server/db/schema.ts`:
```ts
import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Part } from '@/shared/parts'
import type {
  ModelCapabilities, ModelPricing, PersistedStatus, Protocol, SessionParams, Usage, UserSettings,
} from '@/shared/models'

export const users = sqliteTable('users', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  settings: text({ mode: 'json' }).$type<UserSettings>().notNull(),
  created_at: integer().notNull(),
})

export const providers = sqliteTable('providers', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  protocol: text().$type<Protocol>().notNull(),
  base_url: text().notNull(),
  /** AES-GCM ciphertext, base64 "iv.ct"; null when no key stored. */
  api_key: text(),
  extra: text({ mode: 'json' }).$type<Record<string, unknown>>(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  created_at: integer().notNull(),
}, (t) => [index('providers_user_idx').on(t.user_id)])

export const models = sqliteTable('models', {
  id: integer().primaryKey({ autoIncrement: true }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  model_id: text().notNull(),
  display_name: text().notNull(),
  capabilities: text({ mode: 'json' }).$type<ModelCapabilities>().notNull(),
  pricing: text({ mode: 'json' }).$type<ModelPricing>(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  sort: integer().notNull().default(0),
}, (t) => [uniqueIndex('models_provider_model_uq').on(t.provider_id, t.model_id)])

export const sessions = sqliteTable('sessions', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  head_message_id: integer(),
  provider_id: integer(),
  model_id: text(),
  system_prompt: text(),
  params: text({ mode: 'json' }).$type<SessionParams>(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  archived_at: integer(),
}, (t) => [index('sessions_user_updated_idx').on(t.user_id, t.updated_at)])

export const messages = sqliteTable('messages', {
  id: integer().primaryKey({ autoIncrement: true }),
  session_id: integer().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  parent_id: integer().references((): AnySQLiteColumn => messages.id, { onDelete: 'cascade' }),
  seq: integer().notNull(),
  role: text().$type<'user' | 'assistant'>().notNull(),
  parts: text({ mode: 'json' }).$type<Part[]>().notNull(),
  provider_id: integer(),
  model_id: text(),
  usage: text({ mode: 'json' }).$type<Usage>(),
  status: text().$type<PersistedStatus>().notNull(),
  error: text(),
  created_at: integer().notNull(),
}, (t) => [
  uniqueIndex('messages_session_seq_uq').on(t.session_id, t.seq),
  index('messages_parent_idx').on(t.parent_id),
])

export const attachments = sqliteTable('attachments', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  sha256: text().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  width: integer(),
  height: integer(),
  r2_key: text().notNull(),
  origin: text().$type<'upload' | 'generated'>().notNull(),
  created_at: integer().notNull(),
}, (t) => [uniqueIndex('attachments_user_sha_uq').on(t.user_id, t.sha256)])

export type UserRow = typeof users.$inferSelect
export type ProviderRow = typeof providers.$inferSelect
export type ModelRow = typeof models.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type AttachmentRow = typeof attachments.$inferSelect
```

`src/server/db/client.ts`:
```ts
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import * as schema from './schema'

export type DB = DrizzleD1Database<typeof schema> & { $client: D1Database }

export function createDb(d1: D1Database): DB {
  return drizzle(d1, { schema })
}
```

`drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts',
  out: './migrations',
})
```

- [ ] **Step 4: Generate the migration and apply locally**

Run: `pnpm db:generate --name init`
Expected: `migrations/0000_init.sql` and `migrations/meta/_journal.json` + `0000_snapshot.json`. Open the SQL and confirm six `CREATE TABLE` statements, the two unique indexes and the self-referencing `messages.parent_id` FK. Delete `migrations/.gitkeep`.

Run: `pnpm db:migrate:local`
Expected: table listing `0000_init.sql ✅` (answer yes if prompted).

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run test/worker/db.test.ts`
Expected: PASS (2 tests). The setup file applies the migration inside workerd.

- [ ] **Step 6: Commit**

```bash
git add src/server/db drizzle.config.ts migrations test/worker/db.test.ts
git commit -m "feat(db): drizzle schema and initial D1 migration"
```

---

### Task 5: cordis application root with Database and Assets services

**Files:**
- Create: `src/server/app.ts`, `src/server/plugins/database.ts`, `src/server/plugins/assets.ts`, `src/server/cordis.d.ts`
- Test: `test/worker/app.test.ts`

**Interfaces:**
- Consumes: `createDb`, `users` from Task 4.
- Produces:
  - `createApp(options: { env: Env; side: 'worker' | 'hub'; doState?: DurableObjectState }): Promise<Context>`; `Side` type.
  - `ctx.env: Env`, `ctx.doState: DurableObjectState` (hub side only), `ctx.db: Database` with `db.orm: DB`, `ctx.assets: Assets` with `put(key, bytes, mime)`, `getBytes(key): Promise<{ bytes: Uint8Array; mime: string } | null>`, `getStream(key): Promise<{ body: ReadableStream; mime: string; size: number } | null>`, `exists(key)`.
  - `ensureDefaultUser(db: DB): Promise<void>`.
  - Plugin registration happens in `createApp`; later tasks add `LlmPlugin`, `HubPlugin`, `ApiPlugin` to the load lists there.

- [ ] **Step 1: Write the failing test**

`test/worker/app.test.ts`:
```ts
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/server/app'
import { users } from '@/server/db/schema'

describe('createApp', () => {
  it('provides db and assets on the worker side and seeds user 1', async () => {
    const ctx = await createApp({ env, side: 'worker' })
    const rows = await ctx.db.orm.select().from(users)
    expect(rows.map((u) => u.id)).toContain(1)

    await ctx.assets.put('1/ab/abc', new TextEncoder().encode('hello'), 'text/plain')
    expect(await ctx.assets.exists('1/ab/abc')).toBe(true)
    const got = await ctx.assets.getBytes('1/ab/abc')
    expect(got?.mime).toBe('text/plain')
    expect(new TextDecoder().decode(got!.bytes)).toBe('hello')
    expect(await ctx.assets.getBytes('missing')).toBeNull()
  })

  it('builds independent roots', async () => {
    const a = await createApp({ env, side: 'worker' })
    const b = await createApp({ env, side: 'worker' })
    expect(a.db).not.toBe(b.db)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/worker/app.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/server/cordis.d.ts` (type augmentation hub; later tasks append to it):
```ts
import type { Database } from './plugins/database'
import type { Assets } from './plugins/assets'

declare module 'cordis' {
  interface Context {
    env: Env
    doState: DurableObjectState
    db: Database
    assets: Assets
  }
}
```

`src/server/plugins/database.ts`:
```ts
import { Context, Service } from 'cordis'
import { createDb, type DB } from '../db/client'
import { users } from '../db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'

export async function ensureDefaultUser(db: DB): Promise<void> {
  await db
    .insert(users)
    .values({ id: DEFAULT_USER_ID, name: 'owner', settings: { plugins: {} }, created_at: Date.now() })
    .onConflictDoNothing()
}

export class Database extends Service {
  static readonly provide = 'db'
  static readonly inject = ['env']

  readonly orm: DB

  constructor(ctx: Context) {
    super(ctx, 'db')
    this.orm = createDb(ctx.env.DB)
  }

  async [Service.init]() {
    await ensureDefaultUser(this.orm)
  }
}
```

`src/server/plugins/assets.ts`:
```ts
import { Context, Service } from 'cordis'

export interface StoredBytes {
  bytes: Uint8Array
  mime: string
}

export interface StoredStream {
  body: ReadableStream
  mime: string
  size: number
}

export class Assets extends Service {
  static readonly provide = 'assets'
  static readonly inject = ['env']

  private readonly _bucket: R2Bucket

  constructor(ctx: Context) {
    super(ctx, 'assets')
    this._bucket = ctx.env.BUCKET
  }

  async put(key: string, bytes: Uint8Array | ArrayBuffer, mime: string): Promise<void> {
    await this._bucket.put(key, bytes, { httpMetadata: { contentType: mime } })
  }

  async exists(key: string): Promise<boolean> {
    return (await this._bucket.head(key)) !== null
  }

  async getBytes(key: string): Promise<StoredBytes | null> {
    const obj = await this._bucket.get(key)
    if (!obj) return null
    return { bytes: new Uint8Array(await obj.arrayBuffer()), mime: obj.httpMetadata?.contentType ?? 'application/octet-stream' }
  }

  async getStream(key: string): Promise<StoredStream | null> {
    const obj = await this._bucket.get(key)
    if (!obj) return null
    return { body: obj.body, mime: obj.httpMetadata?.contentType ?? 'application/octet-stream', size: obj.size }
  }
}
```

`src/server/app.ts`:
```ts
import { Context } from 'cordis'
import { Database } from './plugins/database'
import { Assets } from './plugins/assets'

export type Side = 'worker' | 'hub'

export interface AppOptions {
  env: Env
  side: Side
  doState?: DurableObjectState
}

/**
 * Builds a cordis root. The Worker isolate and each UserHub DO instance each own one.
 * Plugin activation in cordis is always async, so callers must await this before using services.
 */
export async function createApp(options: AppOptions): Promise<Context> {
  const ctx = new Context()
  ctx.logger.exporter({
    colors: false,
    export: (m) => console.log(`[cordis:${m.type}] ${m.name}`, ...m.args),
  })
  ctx.provide('env', options.env)
  if (options.doState) ctx.provide('doState', options.doState)

  await ctx.plugin(Database)
  await ctx.plugin(Assets)
  // Task 8 adds: if (options.side === 'hub') await ctx.plugin(LlmPlugin)
  // Task 10 adds: if (options.side === 'hub') await ctx.plugin(HubPlugin)
  // Task 12 adds: if (options.side === 'worker') await ctx.plugin(ApiPlugin)
  return ctx
}
```

Check the logger exporter option names against `node_modules/cordis/lib/logger.d.ts` (`Logger.Exporter` has `colors` and `export`); adjust if the field is named differently.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run test/worker/app.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/cordis.d.ts src/server/plugins test/worker/app.test.ts
git commit -m "feat(server): cordis root with database and assets services"
```

---

### Task 6: Usage mapping and API-key encryption

**Files:**
- Create: `src/server/plugins/llm/usage.ts`, `src/server/plugins/llm/crypto.ts`
- Test: `test/unit/llm-usage.test.ts`, `test/unit/llm-crypto.test.ts`

**Interfaces:**
- Produces: `toUsage(u: LanguageModelUsage | undefined): Usage | null`; `encryptSecret(secret: string, plaintext: string): Promise<string>`; `decryptSecret(secret: string, ciphertext: string): Promise<string>`.

- [ ] **Step 1: Write failing tests**

`test/unit/llm-usage.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { toUsage } from '@/server/plugins/llm/usage'

describe('toUsage', () => {
  it('maps the nested AI SDK usage to the flat shape', () => {
    expect(toUsage({
      inputTokens: 10,
      inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0 },
      outputTokens: 5,
      outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
      totalTokens: 15,
    })).toEqual({ prompt: 10, completion: 5, cached: 2, reasoning: 2 })
  })

  it('keeps undefined for unreported fields and 0 for reported zeros', () => {
    const u = toUsage({
      inputTokens: 4,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokens: 0,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: 4,
    })
    expect(u).toEqual({ prompt: 4, completion: 0 })
    expect(Object.keys(u!)).toEqual(['prompt', 'completion'])
  })

  it('returns null without usage', () => {
    expect(toUsage(undefined)).toBeNull()
  })
})
```

`test/unit/llm-crypto.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '@/server/plugins/llm/crypto'

describe('secret crypto', () => {
  it('round-trips and never repeats ciphertext', async () => {
    const a = await encryptSecret('master', 'sk-123')
    const b = await encryptSecret('master', 'sk-123')
    expect(a).not.toBe(b)
    expect(await decryptSecret('master', a)).toBe('sk-123')
  })

  it('fails with the wrong master secret', async () => {
    const ct = await encryptSecret('master', 'sk-123')
    await expect(decryptSecret('other', ct)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/llm-usage.test.ts test/unit/llm-crypto.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/server/plugins/llm/usage.ts`:
```ts
import type { LanguageModelUsage } from 'ai'
import type { Usage } from '@/shared/models'

/** Flattens AI SDK 7's nested usage. Absent keys mean "not reported"; 0 means "reported zero". */
export function toUsage(u: LanguageModelUsage | undefined): Usage | null {
  if (!u) return null
  const out: Usage = {}
  if (u.inputTokens !== undefined) out.prompt = u.inputTokens
  if (u.outputTokens !== undefined) out.completion = u.outputTokens
  if (u.inputTokenDetails?.cacheReadTokens !== undefined) out.cached = u.inputTokenDetails.cacheReadTokens
  if (u.outputTokenDetails?.reasoningTokens !== undefined) out.reasoning = u.outputTokenDetails.reasoningTokens
  return out
}
```

`src/server/plugins/llm/crypto.ts`:
```ts
const enc = new TextEncoder()
const dec = new TextDecoder()

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

/** Returns "base64(iv).base64(ciphertext)". */
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`
}

export async function decryptSecret(secret: string, ciphertext: string): Promise<string> {
  const [ivB64, ctB64] = ciphertext.split('.')
  if (!ivB64 || !ctB64) throw new Error('malformed ciphertext')
  const key = await deriveKey(secret)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) }, key, fromBase64(ctB64))
  return dec.decode(pt)
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/llm-usage.test.ts test/unit/llm-crypto.test.ts`
Expected: PASS (5 tests). Node 24 has WebCrypto on `globalThis.crypto`.

- [ ] **Step 5: Commit**

```bash
git add src/server/plugins/llm test/unit/llm-usage.test.ts test/unit/llm-crypto.test.ts
git commit -m "feat(llm): usage flattening and api-key encryption"
```

---

### Task 7: buildModelMessages (prefix-cache invariant) and PartAccumulator

**Files:**
- Create: `src/server/plugins/llm/messages.ts`, `src/server/plugins/llm/accumulator.ts`
- Test: `test/unit/llm-messages.test.ts`, `test/unit/llm-accumulator.test.ts`, snapshots under `test/unit/__snapshots__/`

**Interfaces:**
- Consumes: `Part`, `Message`, `Protocol`, `SessionParams`, `ModelCapabilities` from shared; `toUsage`.
- Produces:
  - `messages.ts`:
    ```ts
    export interface ImageBytes { bytes: Uint8Array; mime: string }
    export interface BuildInput {
      protocol: Protocol
      systemPrompt: string | null
      path: Message[]                     // root → leaf, the last one is the user message being answered
      images: ReadonlyMap<number, ImageBytes>   // attachment_id → bytes
    }
    export function buildModelMessages(input: BuildInput): ModelMessage[]
    export function buildProviderOptions(protocol: Protocol, params: SessionParams | null, caps: ModelCapabilities): ProviderOptions
    export const COMPAT_PROVIDER_NAME = 'compat'
    ```
  - `accumulator.ts`:
    ```ts
    export type AccEvent =
      | { kind: 'delta'; part_index: number; part_kind: 'text' | 'reasoning'; delta: string }
      | { kind: 'part'; part_index: number; part: Part }
    export class PartAccumulator {
      readonly parts: Part[]
      apply(part: TextStreamPart<ToolSet>): AccEvent[]
    }
    ```

- [ ] **Step 1: Write failing tests**

`test/unit/llm-messages.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildModelMessages, buildProviderOptions, type BuildInput } from '@/server/plugins/llm/messages'
import type { Message } from '@/shared/models'
import type { Protocol } from '@/shared/models'

const png = new Uint8Array([137, 80, 78, 71])

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    session_id: 1, parent_id: null, seq: over.id, provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 0, ...over,
  }
}

const path: Message[] = [
  msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', attachment_id: 9 }] }),
  msg({ id: 2, role: 'assistant', parts: [
    { type: 'reasoning', text: 'hmm', providerOptions: { anthropic: { signature: 'SIG' }, openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC' } } },
    { type: 'text', text: 'a cat' },
  ] }),
  msg({ id: 3, role: 'user', parts: [{ type: 'text', text: 'and now?' }] }),
]

function input(protocol: Protocol): BuildInput {
  return { protocol, systemPrompt: 'be brief', path, images: new Map([[9, { bytes: png, mime: 'image/png' }]]) }
}

describe('buildModelMessages', () => {
  const protocols: Protocol[] = ['openai-completions', 'openai-responses', 'anthropic', 'vertex']

  for (const p of protocols) {
    it(`is byte-identical after a JSON round trip of the parts (${p})`, () => {
      const a = buildModelMessages(input(p))
      const roundTripped: BuildInput = { ...input(p), path: JSON.parse(JSON.stringify(path)) }
      const b = buildModelMessages(roundTripped)
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    })

    it(`matches the golden snapshot (${p})`, () => {
      expect(buildModelMessages(input(p))).toMatchSnapshot()
    })
  }

  it('puts the system prompt first as a system message', () => {
    const out = buildModelMessages(input('openai-responses'))
    expect(out[0]).toMatchObject({ role: 'system', content: 'be brief' })
  })

  it('omits the system message when there is no prompt', () => {
    const out = buildModelMessages({ ...input('anthropic'), systemPrompt: null })
    expect(out[0]!.role).toBe('user')
  })

  it('inlines images as file parts with raw bytes', () => {
    const out = buildModelMessages(input('anthropic'))
    const user = out[1] as { content: Array<{ type: string; mediaType?: string; data?: unknown }> }
    expect(user.content[1]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } })
  })

  it('drops reasoning for openai-completions and keeps it elsewhere', () => {
    const compat = buildModelMessages(input('openai-completions'))
    const anthropic = buildModelMessages(input('anthropic'))
    const types = (m: unknown) => (m as { content: Array<{ type: string }> }).content.map((c) => c.type)
    expect(types(compat[2])).toEqual(['text'])
    expect(types(anthropic[2])).toEqual(['reasoning', 'text'])
  })

  it('places anthropic cache breakpoints on system and last user message only', () => {
    const out = buildModelMessages(input('anthropic')) as Array<{ providerOptions?: unknown }>
    expect(out[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    expect(out[1]!.providerOptions).toBeUndefined()
    expect(out.at(-1)!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
    const oa = buildModelMessages(input('openai-responses')) as Array<{ providerOptions?: unknown }>
    expect(oa.every((m) => m.providerOptions === undefined)).toBe(true)
  })

  it('throws when an image is missing from the map', () => {
    expect(() => buildModelMessages({ ...input('anthropic'), images: new Map() })).toThrow(/attachment 9/)
  })
})

describe('buildProviderOptions', () => {
  it('forces store:false on openai responses', () => {
    expect(buildProviderOptions('openai-responses', null, {})).toEqual({ openai: { store: false } })
  })
  it('maps reasoning_effort per protocol', () => {
    expect(buildProviderOptions('openai-responses', { reasoning_effort: 'high' }, { reasoning: true }))
      .toEqual({ openai: { store: false, reasoningEffort: 'high', reasoningSummary: 'auto' } })
    expect(buildProviderOptions('openai-completions', { reasoning_effort: 'low' }, { reasoning: true }))
      .toEqual({ compat: { reasoningEffort: 'low' } })
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'medium' }, { reasoning: true }))
      .toEqual({ anthropic: { effort: 'medium', thinking: { type: 'adaptive', display: 'summarized' } } })
    expect(buildProviderOptions('vertex', { reasoning_effort: 'high' }, { reasoning: true }))
      .toEqual({ googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } } })
  })
  it('ignores reasoning_effort when the model has no reasoning capability', () => {
    expect(buildProviderOptions('anthropic', { reasoning_effort: 'high' }, {})).toEqual({})
  })
})
```

`test/unit/llm-accumulator.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PartAccumulator } from '@/server/plugins/llm/accumulator'

describe('PartAccumulator', () => {
  it('builds reasoning then text parts with indexes and keeps the last provider metadata', () => {
    const acc = new PartAccumulator()
    const events = [
      ...acc.apply({ type: 'reasoning-start', id: 'r1' }),
      ...acc.apply({ type: 'reasoning-delta', id: 'r1', text: 'thi' }),
      ...acc.apply({ type: 'reasoning-delta', id: 'r1', text: 'nk', providerMetadata: { anthropic: { signature: 'SIG' } } }),
      ...acc.apply({ type: 'reasoning-end', id: 'r1' }),
      ...acc.apply({ type: 'text-start', id: 't1' }),
      ...acc.apply({ type: 'text-delta', id: 't1', text: 'Hel' }),
      ...acc.apply({ type: 'text-delta', id: 't1', text: 'lo' }),
      ...acc.apply({ type: 'text-end', id: 't1' }),
    ]
    expect(events).toEqual([
      { kind: 'delta', part_index: 0, part_kind: 'reasoning', delta: 'thi' },
      { kind: 'delta', part_index: 0, part_kind: 'reasoning', delta: 'nk' },
      { kind: 'delta', part_index: 1, part_kind: 'text', delta: 'Hel' },
      { kind: 'delta', part_index: 1, part_kind: 'text', delta: 'lo' },
    ])
    expect(acc.parts).toEqual([
      { type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 'SIG' } } },
      { type: 'text', text: 'Hello' },
    ])
  })

  it('opens a part when a delta arrives without a start', () => {
    const acc = new PartAccumulator()
    acc.apply({ type: 'text-delta', id: 'x', text: 'a' })
    expect(acc.parts).toEqual([{ type: 'text', text: 'a' }])
  })

  it('emits a full part for tool calls', () => {
    const acc = new PartAccumulator()
    const ev = acc.apply({ type: 'tool-call', toolCallId: 'c1', toolName: 'f', input: { a: 1 } } as never)
    expect(ev).toEqual([{ kind: 'part', part_index: 0, part: { type: 'tool_call', id: 'c1', name: 'f', args: { a: 1 } } }])
  })

  it('ignores lifecycle parts', () => {
    const acc = new PartAccumulator()
    expect(acc.apply({ type: 'start' })).toEqual([])
    expect(acc.apply({ type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: { inputTokens: 1, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined }, outputTokens: 1, outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }, totalTokens: 2 } })).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/llm-messages.test.ts test/unit/llm-accumulator.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement messages.ts**

```ts
import type { ModelMessage, AssistantModelMessage, UserModelMessage, ToolModelMessage } from 'ai'
import type { Message, ModelCapabilities, Protocol, SessionParams } from '@/shared/models'
import type { Part, ProviderOptions } from '@/shared/parts'

export const COMPAT_PROVIDER_NAME = 'compat'

export interface ImageBytes {
  bytes: Uint8Array
  mime: string
}

export interface BuildInput {
  protocol: Protocol
  systemPrompt: string | null
  /** Root → leaf. The last element is the user message being answered. */
  path: Message[]
  images: ReadonlyMap<number, ImageBytes>
}

const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const

type UserPart = Extract<UserModelMessage['content'], unknown[]>[number]
type AssistantPart = Extract<AssistantModelMessage['content'], unknown[]>[number]
type ToolPart = ToolModelMessage['content'][number]

function userParts(parts: Part[], images: ReadonlyMap<number, ImageBytes>): UserPart[] {
  const out: UserPart[] = []
  for (const p of parts) {
    if (p.type === 'text') {
      out.push({ type: 'text', text: p.text })
    } else if (p.type === 'image') {
      const img = images.get(p.attachment_id)
      if (!img) throw new Error(`attachment ${p.attachment_id} bytes not provided`)
      out.push({ type: 'file', mediaType: img.mime, data: { type: 'data', data: img.bytes } })
    }
    // reasoning / tool parts never appear on user messages
  }
  return out
}

function assistantParts(parts: Part[], protocol: Protocol): { assistant: AssistantPart[]; tool: ToolPart[] } {
  const assistant: AssistantPart[] = []
  const tool: ToolPart[] = []
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        if (p.text.length > 0) assistant.push({ type: 'text', text: p.text })
        break
      case 'reasoning':
        // openai-completions (openai-compatible endpoints) has nothing to replay and may reject unknown blocks.
        if (protocol === 'openai-completions') break
        if (p.text.length === 0 && !p.providerOptions) break
        assistant.push(p.providerOptions
          ? { type: 'reasoning', text: p.text, providerOptions: p.providerOptions as never }
          : { type: 'reasoning', text: p.text })
        break
      case 'tool_call':
        assistant.push({ type: 'tool-call', toolCallId: p.id, toolName: p.name, input: p.args })
        break
      case 'tool_result':
        tool.push({ type: 'tool-result', toolCallId: p.call_id, toolName: p.name, output: { type: 'json', value: p.content as never } })
        break
      case 'image':
        // Generated images are not replayed to the model in MVP.
        break
    }
  }
  return { assistant, tool }
}

/**
 * Pure. Same input → byte-identical output, whether the parts came from memory or from D1.
 * Nothing request-specific may ever be added here (see spec §7.2).
 */
export function buildModelMessages(input: BuildInput): ModelMessage[] {
  const { protocol, systemPrompt, path, images } = input
  const out: ModelMessage[] = []
  const cache = protocol === 'anthropic'

  if (systemPrompt !== null && systemPrompt.length > 0) {
    out.push(cache
      ? { role: 'system', content: systemPrompt, providerOptions: ANTHROPIC_CACHE }
      : { role: 'system', content: systemPrompt })
  }

  const lastUserIndex = path.map((m) => m.role).lastIndexOf('user')

  path.forEach((m, i) => {
    if (m.role === 'user') {
      const content = userParts(m.parts, images)
      out.push(cache && i === lastUserIndex
        ? { role: 'user', content, providerOptions: ANTHROPIC_CACHE }
        : { role: 'user', content })
      return
    }
    const { assistant, tool } = assistantParts(m.parts, protocol)
    if (assistant.length > 0) out.push({ role: 'assistant', content: assistant })
    if (tool.length > 0) out.push({ role: 'tool', content: tool })
  })

  return out
}

const ANTHROPIC_THINKING = { type: 'adaptive', display: 'summarized' } as const

export function buildProviderOptions(
  protocol: Protocol,
  params: SessionParams | null,
  caps: ModelCapabilities,
): ProviderOptions {
  const effort = caps.reasoning ? params?.reasoning_effort : undefined
  switch (protocol) {
    case 'openai-responses':
      return { openai: { store: false, ...(effort ? { reasoningEffort: effort, reasoningSummary: 'auto' } : {}) } }
    case 'openai-completions':
      return effort ? { [COMPAT_PROVIDER_NAME]: { reasoningEffort: effort } } : {}
    case 'anthropic':
      return effort ? { anthropic: { effort, thinking: ANTHROPIC_THINKING } } : {}
    case 'vertex':
      return effort ? { googleVertex: { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } } } : {}
  }
}
```

If `providerOptions: p.providerOptions as never` fails to typecheck, cast to `ProviderOptions` from `ai` (`import type { ProviderOptions as SdkProviderOptions } from 'ai'`); the runtime shape is identical.

- [ ] **Step 4: Implement accumulator.ts**

```ts
import type { TextStreamPart, ToolSet } from 'ai'
import type { Part, ProviderOptions, ReasoningPart, TextPart } from '@/shared/parts'

export type AccEvent =
  | { kind: 'delta'; part_index: number; part_kind: 'text' | 'reasoning'; delta: string }
  | { kind: 'part'; part_index: number; part: Part }

/**
 * Folds AI SDK stream parts into our Part[] while emitting broadcastable events.
 * One stream `id` maps to one part; consecutive deltas append; type changes open a new part.
 * Provider metadata on reasoning parts: last non-null wins (signatures arrive at the end).
 */
export class PartAccumulator {
  readonly parts: Part[] = []
  private readonly _indexById = new Map<string, number>()

  apply(part: TextStreamPart<ToolSet>): AccEvent[] {
    switch (part.type) {
      case 'text-start':
        this._open(part.id, { type: 'text', text: '' })
        return []
      case 'text-delta': {
        const idx = this._ensure(part.id, { type: 'text', text: '' })
        ;(this.parts[idx] as TextPart).text += part.text
        return [{ kind: 'delta', part_index: idx, part_kind: 'text', delta: part.text }]
      }
      case 'reasoning-start': {
        const idx = this._open(part.id, { type: 'reasoning', text: '' })
        this._mergeMeta(idx, part.providerMetadata)
        return []
      }
      case 'reasoning-delta': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        ;(this.parts[idx] as ReasoningPart).text += part.text
        this._mergeMeta(idx, part.providerMetadata)
        return part.text.length > 0 ? [{ kind: 'delta', part_index: idx, part_kind: 'reasoning', delta: part.text }] : []
      }
      case 'reasoning-end': {
        const idx = this._ensure(part.id, { type: 'reasoning', text: '' })
        this._mergeMeta(idx, part.providerMetadata)
        return []
      }
      case 'tool-call': {
        const p: Part = { type: 'tool_call', id: part.toolCallId, name: part.toolName, args: part.input }
        this.parts.push(p)
        return [{ kind: 'part', part_index: this.parts.length - 1, part: p }]
      }
      default:
        return []
    }
  }

  private _open(id: string, part: Part): number {
    this.parts.push(part)
    const idx = this.parts.length - 1
    this._indexById.set(id, idx)
    return idx
  }

  private _ensure(id: string, part: Part): number {
    return this._indexById.get(id) ?? this._open(id, part)
  }

  private _mergeMeta(idx: number, meta: unknown): void {
    if (!meta) return
    const p = this.parts[idx] as ReasoningPart
    p.providerOptions = meta as ProviderOptions
  }
}
```

- [ ] **Step 5: Run tests, then commit snapshots**

Run: `pnpm vitest run test/unit/llm-messages.test.ts test/unit/llm-accumulator.test.ts`
Expected: PASS; the first run writes `test/unit/__snapshots__/llm-messages.test.ts.snap`. Open the snapshot and eyeball each protocol: anthropic has `providerOptions` on system + last user; openai-completions has no `reasoning` part; the image is a `file` part with `data.type: 'data'`.

Run: `pnpm tsc -p tsconfig.worker.json --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/plugins/llm test/unit
git commit -m "feat(llm): deterministic model-message builder and stream part accumulator"
```

---

### Task 8: Llm service, protocol plugins, presets, model listing

**Files:**
- Create: `src/server/plugins/llm/index.ts`, `src/server/plugins/llm/protocols/openai-completions.ts`, `.../openai-responses.ts`, `.../anthropic.ts`, `.../vertex.ts`, `src/server/plugins/llm/presets.ts`, `src/server/plugins/llm/list-models.ts`
- Modify: `src/server/cordis.d.ts`, `src/server/app.ts`
- Test: `test/worker/llm.test.ts`, `test/unit/llm-list-models.test.ts`

**Interfaces:**
- Consumes: `ProviderRow`, `ModelRow`, `decryptSecret`, `ctx.env.KEY_ENCRYPTION_SECRET`.
- Produces:
  ```ts
  export type ModelFactory = (provider: ProviderRow, model: ModelRow, apiKey: string | null) => LanguageModel
  export class Llm extends Service {            // ctx.llm
    register(protocol: Protocol | string, factory: ModelFactory): () => void   // disposer, caller-scoped
    has(protocol: string): boolean
    createModel(provider: ProviderRow, model: ModelRow): Promise<LanguageModel>
    decryptKey(provider: ProviderRow): Promise<string | null>
  }
  export const LlmPlugin: Plugin   // loads Llm + the four protocol plugins
  export interface PresetProvider { key: string; name: string; protocol: Protocol; base_url: string; models: Array<{ model_id: string; display_name: string; capabilities: ModelCapabilities }> }
  export const PRESET_PROVIDERS: PresetProvider[]
  export async function listRemoteModels(provider: ProviderRow, apiKey: string | null, fetchFn?: typeof fetch): Promise<string[]>
  ```
- Vertex provider rows: `api_key` holds the service-account JSON (encrypted), `extra` holds `{ project, location }`.

- [ ] **Step 1: Write failing tests**

`test/worker/llm.test.ts`:
```ts
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/server/app'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import type { ModelRow, ProviderRow } from '@/server/db/schema'

const model: ModelRow = { id: 1, provider_id: 1, model_id: 'test-model', display_name: 'x', capabilities: {}, pricing: null, enabled: true, sort: 0 }

async function provider(protocol: ProviderRow['protocol'], key: string | null, extra: Record<string, unknown> | null = null): Promise<ProviderRow> {
  return {
    id: 1, user_id: 1, name: 'p', protocol, base_url: 'https://example.com/v1',
    api_key: key ? await encryptSecret(env.KEY_ENCRYPTION_SECRET, key) : null, extra, enabled: true, created_at: 0,
  }
}

describe('Llm service', () => {
  it('registers the four protocols and builds models without network', async () => {
    const ctx = await createApp({ env, side: 'hub' })
    for (const p of ['openai-completions', 'openai-responses', 'anthropic', 'vertex'] as const) expect(ctx.llm.has(p)).toBe(true)

    const compat = await ctx.llm.createModel(await provider('openai-completions', 'k'), model)
    expect(compat.provider).toBe('compat.chat')
    expect(compat.modelId).toBe('test-model')

    const responses = await ctx.llm.createModel(await provider('openai-responses', 'k'), model)
    expect(responses.provider).toBe('openai.responses')

    const anthropic = await ctx.llm.createModel(await provider('anthropic', 'k'), model)
    expect(anthropic.provider).toBe('anthropic.messages')

    const sa = JSON.stringify({ client_email: 'a@b', private_key: 'PEM', private_key_id: 'kid' })
    const vertex = await ctx.llm.createModel(await provider('vertex', sa, { project: 'proj', location: 'us-central1' }), model)
    expect(vertex.provider).toBe('google.vertex.chat')
  })

  it('rejects a missing key', async () => {
    const ctx = await createApp({ env, side: 'hub' })
    await expect(ctx.llm.createModel(await provider('anthropic', null), model)).rejects.toThrow(/api key/i)
  })

  it('lets a test register a custom protocol and disposes it with the caller', async () => {
    const ctx = await createApp({ env, side: 'hub' })
    const fiber = await ctx.plugin({ name: 'mock-protocol', inject: ['llm'], apply(c) { c.llm.register('mock', () => ({ provider: 'mock' }) as never) } })
    expect(ctx.llm.has('mock')).toBe(true)
    await fiber.dispose()
    expect(ctx.llm.has('mock')).toBe(false)
  })
})
```

`test/unit/llm-list-models.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { listRemoteModels } from '@/server/plugins/llm/list-models'
import type { ProviderRow } from '@/server/db/schema'

const base: ProviderRow = { id: 1, user_id: 1, name: 'p', protocol: 'openai-completions', base_url: 'https://api.example.com/v1', api_key: null, extra: null, enabled: true, created_at: 0 }

describe('listRemoteModels', () => {
  it('calls {base_url}/models with a bearer token for openai protocols', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const ids = await listRemoteModels(base, 'sk', fetchFn)
    expect(ids).toEqual(['a', 'b'])
    expect(calls[0]![0]).toBe('https://api.example.com/v1/models')
    expect((calls[0]![1]!.headers as Record<string, string>).Authorization).toBe('Bearer sk')
  })

  it('uses x-api-key and anthropic-version for anthropic', async () => {
    let headers: Record<string, string> = {}
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      headers = init!.headers as Record<string, string>
      return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const ids = await listRemoteModels({ ...base, protocol: 'anthropic' }, 'sk', fetchFn)
    expect(ids).toEqual(['claude-x'])
    expect(headers['x-api-key']).toBe('sk')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('throws on non-2xx', async () => {
    const fetchFn = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(listRemoteModels(base, 'sk', fetchFn)).rejects.toThrow(/401/)
  })

  it('refuses vertex (no listing endpoint)', async () => {
    await expect(listRemoteModels({ ...base, protocol: 'vertex' }, 'sk')).rejects.toThrow(/not supported/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/worker/llm.test.ts test/unit/llm-list-models.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the service and protocol plugins**

`src/server/plugins/llm/index.ts`:
```ts
import { Context, Service } from 'cordis'
import type { LanguageModel } from 'ai'
import type { ModelRow, ProviderRow } from '../../db/schema'
import { decryptSecret } from './crypto'
import { openaiCompletionsProtocol } from './protocols/openai-completions'
import { openaiResponsesProtocol } from './protocols/openai-responses'
import { anthropicProtocol } from './protocols/anthropic'
import { vertexProtocol } from './protocols/vertex'

export type ModelFactory = (provider: ProviderRow, model: ModelRow, apiKey: string | null) => LanguageModel

export class Llm extends Service {
  static readonly provide = 'llm'
  static readonly inject = ['env']

  private readonly _factories = new Map<string, ModelFactory>()
  private readonly _secret: string

  constructor(ctx: Context) {
    super(ctx, 'llm')
    this._secret = ctx.env.KEY_ENCRYPTION_SECRET
  }

  /** Caller-scoped: the registration is removed when the registering plugin is disposed. */
  register(protocol: string, factory: ModelFactory): () => void {
    return this.ctx.effect(() => {
      this._factories.set(protocol, factory)
      return () => { this._factories.delete(protocol) }
    }, `llm.register(${protocol})`)
  }

  has(protocol: string): boolean {
    return this._factories.has(protocol)
  }

  async decryptKey(provider: ProviderRow): Promise<string | null> {
    return provider.api_key ? decryptSecret(this._secret, provider.api_key) : null
  }

  async createModel(provider: ProviderRow, model: ModelRow): Promise<LanguageModel> {
    const factory = this._factories.get(provider.protocol)
    if (!factory) throw new Error(`no factory for protocol ${provider.protocol}`)
    const key = await this.decryptKey(provider)
    if (key === null) throw new Error(`provider ${provider.id} has no API key`)
    return factory(provider, model, key)
  }
}

export const LlmPlugin = {
  name: 'llm',
  async apply(ctx: Context) {
    await ctx.plugin(Llm)
    await ctx.plugin(openaiCompletionsProtocol)
    await ctx.plugin(openaiResponsesProtocol)
    await ctx.plugin(anthropicProtocol)
    await ctx.plugin(vertexProtocol)
  },
}
```

`src/server/plugins/llm/protocols/openai-completions.ts`:
```ts
import type { Context } from 'cordis'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { COMPAT_PROVIDER_NAME } from '../messages'

export const openaiCompletionsProtocol = {
  name: 'llm-openai-completions',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('openai-completions', (provider, model, apiKey) => {
      const p = createOpenAICompatible({
        name: COMPAT_PROVIDER_NAME,
        baseURL: provider.base_url,
        apiKey: apiKey ?? undefined,
        includeUsage: true,
      })
      return p.chatModel(model.model_id)
    })
  },
}
```

`src/server/plugins/llm/protocols/openai-responses.ts`:
```ts
import type { Context } from 'cordis'
import { createOpenAI } from '@ai-sdk/openai'

export const openaiResponsesProtocol = {
  name: 'llm-openai-responses',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('openai-responses', (provider, model, apiKey) => {
      const p = createOpenAI({ baseURL: provider.base_url, apiKey: apiKey ?? undefined })
      return p.responses(model.model_id)
    })
  },
}
```

`src/server/plugins/llm/protocols/anthropic.ts`:
```ts
import type { Context } from 'cordis'
import { createAnthropic } from '@ai-sdk/anthropic'

export const anthropicProtocol = {
  name: 'llm-anthropic',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('anthropic', (provider, model, apiKey) => {
      const p = createAnthropic({ baseURL: provider.base_url, apiKey: apiKey ?? undefined })
      return p(model.model_id)
    })
  },
}
```

`src/server/plugins/llm/protocols/vertex.ts`:
```ts
import type { Context } from 'cordis'
import { createGoogleVertex } from '@ai-sdk/google-vertex/edge'
import { z } from 'zod'

const ServiceAccountSchema = z.object({
  client_email: z.string(),
  private_key: z.string(),
  private_key_id: z.string().optional(),
})
const ExtraSchema = z.object({ project: z.string(), location: z.string() })

export const vertexProtocol = {
  name: 'llm-vertex',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('vertex', (provider, model, apiKey) => {
      const sa = ServiceAccountSchema.parse(JSON.parse(apiKey ?? '{}'))
      const extra = ExtraSchema.parse(provider.extra ?? {})
      const p = createGoogleVertex({
        project: extra.project,
        location: extra.location,
        googleCredentials: { clientEmail: sa.client_email, privateKey: sa.private_key, privateKeyId: sa.private_key_id },
      })
      return p(model.model_id)
    })
  },
}
```
(`base_url` is ignored for vertex. Token caching is a known follow-up: the SDK signs a JWT per request.)

`src/server/plugins/llm/presets.ts`:
```ts
import type { ModelCapabilities, Protocol } from '@/shared/models'

export interface PresetModel { model_id: string; display_name: string; capabilities: ModelCapabilities }
export interface PresetProvider { key: string; name: string; protocol: Protocol; base_url: string; models: PresetModel[] }

export const PRESET_PROVIDERS: PresetProvider[] = [
  {
    key: 'openai', name: 'OpenAI', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1',
    models: [
      { model_id: 'gpt-5.1', display_name: 'GPT-5.1', capabilities: { vision: true, reasoning: true, tools: true } },
      { model_id: 'gpt-5-mini', display_name: 'GPT-5 mini', capabilities: { vision: true, reasoning: true, tools: true } },
    ],
  },
  {
    key: 'anthropic', name: 'Anthropic', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1',
    models: [
      { model_id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', capabilities: { vision: true, reasoning: true, tools: true } },
      { model_id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', capabilities: { vision: true, reasoning: true, tools: true } },
    ],
  },
  {
    key: 'deepseek', name: 'DeepSeek', protocol: 'openai-completions', base_url: 'https://api.deepseek.com/v1',
    models: [
      { model_id: 'deepseek-chat', display_name: 'DeepSeek Chat', capabilities: { tools: true } },
      { model_id: 'deepseek-reasoner', display_name: 'DeepSeek Reasoner', capabilities: { reasoning: true } },
    ],
  },
  {
    key: 'openrouter', name: 'OpenRouter', protocol: 'openai-completions', base_url: 'https://openrouter.ai/api/v1',
    models: [],
  },
  {
    key: 'vertex', name: 'Google Vertex AI', protocol: 'vertex', base_url: 'https://aiplatform.googleapis.com',
    models: [
      { model_id: 'gemini-3-pro-preview', display_name: 'Gemini 3 Pro', capabilities: { vision: true, reasoning: true, tools: true } },
    ],
  },
]
```
(Model ids are templates the user can edit; they are not fetched. The Vertex `extra` fields `project` / `location` are typed in by the user in the provider form.)

`src/server/plugins/llm/list-models.ts`:
```ts
import type { ProviderRow } from '../../db/schema'

/** GET {base_url}/models. The AI SDK has no listing API, so we call the endpoint directly. */
export async function listRemoteModels(
  provider: ProviderRow,
  apiKey: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  if (provider.protocol === 'vertex') throw new Error('model listing is not supported for vertex')
  const url = `${provider.base_url.replace(/\/$/, '')}/models`
  const headers: Record<string, string> = provider.protocol === 'anthropic'
    ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey ?? ''}` }
  const res = await fetchFn(url, { headers })
  if (!res.ok) throw new Error(`model listing failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((m) => m.id).sort()
}
```

Append to `src/server/cordis.d.ts`:
```ts
import type { Llm } from './plugins/llm'
declare module 'cordis' {
  interface Context {
    llm: Llm
  }
}
```

In `src/server/app.ts` add `import { LlmPlugin } from './plugins/llm'` and after `await ctx.plugin(Assets)`:
```ts
  if (options.side === 'hub') await ctx.plugin(LlmPlugin)
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/worker/llm.test.ts test/unit/llm-list-models.test.ts`
Expected: PASS (7 tests). If a `.provider` string differs from the expectation, print it and update the test to the real value from the installed package — the assertion exists to prove the right factory ran, not to pin a string.

Run: `pnpm tsc -p tsconfig.worker.json --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server test/worker/llm.test.ts test/unit/llm-list-models.test.ts
git commit -m "feat(llm): protocol registry with four provider plugins, presets and model listing"
```

---
### Task 9: Hub pure helpers — seq allocator, tree walk, session D1 ops

**Files:**
- Create: `src/server/plugins/hub/seq.ts`, `src/server/plugins/hub/tree.ts`, `src/server/plugins/hub/sessions.ts`
- Test: `test/unit/hub-seq.test.ts`, `test/unit/hub-tree.test.ts`, `test/worker/hub-sessions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // seq.ts
  export class SeqAllocator { allocate(sessionId: number, loadMax: () => Promise<number>): Promise<number>; forget(sessionId: number): void }
  // tree.ts
  export function pathToRoot(byId: ReadonlyMap<number, Message>, headId: number | null): Message[]   // root → leaf
  export function siblingsOf(all: readonly Message[], message: Message): Message[]                   // same parent, sorted by seq
  export function titleFromParts(parts: Part[]): string
  // sessions.ts (all take DB as first arg)
  listSessions(db, userId): Promise<SessionRow[]>; getSession(db, id): Promise<SessionRow | undefined>
  createSession(db, input: { user_id; title; provider_id; model_id }): Promise<SessionRow>
  updateSession(db, id, patch: Partial<Pick<SessionRow, 'title' | 'provider_id' | 'model_id' | 'system_prompt' | 'params' | 'head_message_id'>>): Promise<SessionRow>
  deleteSession(db, id): Promise<void>
  listMessages(db, sessionId): Promise<MessageRow[]>; getMessage(db, id): Promise<MessageRow | undefined>
  insertMessage(db, row: Omit<MessageRow, 'id'>): Promise<MessageRow>
  finalizeMessage(db, id, patch: { parts; usage; status; error }): Promise<void>
  maxSeq(db, sessionId): Promise<number>
  getUser(db, id): Promise<UserRow | undefined>; updateUserSettings(db, id, settings): Promise<UserRow>
  getProvider(db, id): Promise<ProviderRow | undefined>; getModel(db, providerId, modelId): Promise<ModelRow | undefined>
  getAttachment(db, id): Promise<AttachmentRow | undefined>
  toMessage(row: MessageRow, status?: MessageStatus): Message   // DTO with wire status
  ```

- [ ] **Step 1: Write failing tests**

`test/unit/hub-seq.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { SeqAllocator } from '@/server/plugins/hub/seq'

describe('SeqAllocator', () => {
  it('initialises from the db once and then counts in memory', async () => {
    let loads = 0
    const load = async () => { loads++; return 5 }
    const a = new SeqAllocator()
    expect(await a.allocate(1, load)).toBe(6)
    expect(await a.allocate(1, load)).toBe(7)
    expect(loads).toBe(1)
  })

  it('dedupes concurrent first allocations', async () => {
    let loads = 0
    const load = () => new Promise<number>((r) => setTimeout(() => { loads++; r(0) }, 5))
    const a = new SeqAllocator()
    const [x, y] = await Promise.all([a.allocate(2, load), a.allocate(2, load)])
    expect(new Set([x, y]).size).toBe(2)
    expect(loads).toBe(1)
  })
})
```

`test/unit/hub-tree.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { pathToRoot, siblingsOf, titleFromParts } from '@/server/plugins/hub/tree'
import type { Message } from '@/shared/models'

function m(id: number, parent_id: number | null, seq = id): Message {
  return { id, session_id: 1, parent_id, seq, role: id % 2 ? 'user' : 'assistant', parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0 }
}
// 1 → 2 → 3 ; 1 → 4 (sibling of 2) ; 4 → 5
const all = [m(1, null), m(2, 1), m(3, 2), m(4, 1), m(5, 4)]
const byId = new Map(all.map((x) => [x.id, x]))

describe('tree', () => {
  it('walks head to root and returns root-first', () => {
    expect(pathToRoot(byId, 5).map((x) => x.id)).toEqual([1, 4, 5])
    expect(pathToRoot(byId, 3).map((x) => x.id)).toEqual([1, 2, 3])
  })
  it('returns empty for null head', () => {
    expect(pathToRoot(byId, null)).toEqual([])
  })
  it('lists siblings sorted by seq including self', () => {
    expect(siblingsOf(all, byId.get(4)!).map((x) => x.id)).toEqual([2, 4])
    expect(siblingsOf(all, byId.get(1)!).map((x) => x.id)).toEqual([1])
  })
  it('derives a title from the first text part', () => {
    expect(titleFromParts([{ type: 'image', attachment_id: 1 }, { type: 'text', text: '  Hello world  ' }])).toBe('Hello world')
    expect(titleFromParts([{ type: 'text', text: 'x'.repeat(100) }])).toHaveLength(40)
    expect(titleFromParts([{ type: 'image', attachment_id: 1 }])).toBe('新对话')
  })
})
```

`test/worker/hub-sessions.test.ts`:
```ts
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { createSession, finalizeMessage, insertMessage, listMessages, maxSeq, toMessage, updateSession } from '@/server/plugins/hub/sessions'

describe('session ops', () => {
  it('creates, inserts, finalizes, and reads back with wire status', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const s = await createSession(db, { user_id: 1, title: 't', provider_id: null, model_id: null })
    expect(await maxSeq(db, s.id)).toBe(0)
    const u = await insertMessage(db, { session_id: s.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hi' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1 })
    const a = await insertMessage(db, { session_id: s.id, parent_id: u.id, seq: 2, role: 'assistant', parts: [], provider_id: null, model_id: 'm', usage: null, status: 'error', error: null, created_at: 2 })
    await finalizeMessage(db, a.id, { parts: [{ type: 'text', text: 'yo' }], usage: { prompt: 1 }, status: 'done', error: null })
    const rows = await listMessages(db, s.id)
    expect(rows.map((r) => r.status)).toEqual(['done', 'done'])
    expect(toMessage(rows[1]!, 'streaming').status).toBe('streaming')
    expect(await maxSeq(db, s.id)).toBe(2)
    const s2 = await updateSession(db, s.id, { head_message_id: a.id, title: 'renamed' })
    expect(s2.head_message_id).toBe(a.id)
    expect(s2.updated_at).toBeGreaterThanOrEqual(s.updated_at)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/unit/hub-seq.test.ts test/unit/hub-tree.test.ts test/worker/hub-sessions.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/server/plugins/hub/seq.ts`:
```ts
/**
 * Per-session monotonic counter. Initialised once from the db's max(seq), then purely in memory.
 * The UserHub DO is the single writer for its user, so no cross-instance coordination is needed.
 */
export class SeqAllocator {
  private readonly _counters = new Map<number, number>()
  private readonly _inits = new Map<number, Promise<void>>()

  async allocate(sessionId: number, loadMax: () => Promise<number>): Promise<number> {
    if (!this._counters.has(sessionId)) {
      let init = this._inits.get(sessionId)
      if (!init) {
        init = loadMax().then((max) => { this._counters.set(sessionId, max) }).finally(() => { this._inits.delete(sessionId) })
        this._inits.set(sessionId, init)
      }
      await init
    }
    const next = (this._counters.get(sessionId) ?? 0) + 1
    this._counters.set(sessionId, next)
    return next
  }

  forget(sessionId: number): void {
    this._counters.delete(sessionId)
  }
}
```

`src/server/plugins/hub/tree.ts`:
```ts
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'

export function pathToRoot(byId: ReadonlyMap<number, Message>, headId: number | null): Message[] {
  const out: Message[] = []
  let cur = headId === null ? undefined : byId.get(headId)
  const seen = new Set<number>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.push(cur)
    cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id)
  }
  return out.reverse()
}

export function siblingsOf(all: readonly Message[], message: Message): Message[] {
  return all.filter((m) => m.parent_id === message.parent_id).sort((a, b) => a.seq - b.seq)
}

export function titleFromParts(parts: Part[]): string {
  const text = parts.find((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')?.text.trim() ?? ''
  return text.length > 0 ? text.slice(0, 40) : '新对话'
}
```

`src/server/plugins/hub/sessions.ts`:
```ts
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { DB } from '../../db/client'
import { attachments, messages, models, providers, sessions, users } from '../../db/schema'
import type { AttachmentRow, MessageRow, ModelRow, ProviderRow, SessionRow, UserRow } from '../../db/schema'
import type { Message, MessageStatus, PersistedStatus, Usage, UserSettings } from '@/shared/models'
import type { Part } from '@/shared/parts'

export function toMessage(row: MessageRow, status: MessageStatus = row.status): Message {
  return { ...row, status }
}

export async function listSessions(db: DB, userId: number): Promise<SessionRow[]> {
  return db.select().from(sessions).where(and(eq(sessions.user_id, userId), isNull(sessions.archived_at))).orderBy(desc(sessions.updated_at))
}

export async function getSession(db: DB, id: number): Promise<SessionRow | undefined> {
  return db.query.sessions.findFirst({ where: eq(sessions.id, id) })
}

export async function createSession(db: DB, input: { user_id: number; title: string; provider_id: number | null; model_id: string | null }): Promise<SessionRow> {
  const now = Date.now()
  const [row] = await db.insert(sessions).values({ ...input, head_message_id: null, system_prompt: null, params: null, created_at: now, updated_at: now, archived_at: null }).returning()
  return row!
}

export async function updateSession(
  db: DB,
  id: number,
  patch: Partial<Pick<SessionRow, 'title' | 'provider_id' | 'model_id' | 'system_prompt' | 'params' | 'head_message_id'>>,
): Promise<SessionRow> {
  const [row] = await db.update(sessions).set({ ...patch, updated_at: Date.now() }).where(eq(sessions.id, id)).returning()
  if (!row) throw new Error(`session ${id} not found`)
  return row
}

export async function deleteSession(db: DB, id: number): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id))   // messages cascade
}

export async function listMessages(db: DB, sessionId: number): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.session_id, sessionId)).orderBy(messages.seq)
}

export async function getMessage(db: DB, id: number): Promise<MessageRow | undefined> {
  return db.query.messages.findFirst({ where: eq(messages.id, id) })
}

export async function insertMessage(db: DB, row: Omit<MessageRow, 'id'>): Promise<MessageRow> {
  const [inserted] = await db.insert(messages).values(row).returning()
  return inserted!
}

export async function finalizeMessage(
  db: DB,
  id: number,
  patch: { parts: Part[]; usage: Usage | null; status: PersistedStatus; error: string | null },
): Promise<void> {
  await db.update(messages).set(patch).where(eq(messages.id, id))
}

export async function maxSeq(db: DB, sessionId: number): Promise<number> {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${messages.seq}), 0)` }).from(messages).where(eq(messages.session_id, sessionId))
  return row?.max ?? 0
}

export async function getUser(db: DB, id: number): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) })
}

export async function updateUserSettings(db: DB, id: number, settings: UserSettings): Promise<UserRow> {
  const [row] = await db.update(users).set({ settings }).where(eq(users.id, id)).returning()
  if (!row) throw new Error(`user ${id} not found`)
  return row
}

export async function getProvider(db: DB, id: number): Promise<ProviderRow | undefined> {
  return db.query.providers.findFirst({ where: eq(providers.id, id) })
}

export async function getModel(db: DB, providerId: number, modelId: string): Promise<ModelRow | undefined> {
  return db.query.models.findFirst({ where: and(eq(models.provider_id, providerId), eq(models.model_id, modelId)) })
}

export async function getAttachment(db: DB, id: number): Promise<AttachmentRow | undefined> {
  return db.query.attachments.findFirst({ where: eq(attachments.id, id) })
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/hub-seq.test.ts test/unit/hub-tree.test.ts test/worker/hub-sessions.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/plugins/hub test/unit/hub-seq.test.ts test/unit/hub-tree.test.ts test/worker/hub-sessions.test.ts
git commit -m "feat(hub): seq allocator, tree walk and session persistence helpers"
```

---

### Task 10: Hub service and UserHub Durable Object (sockets, snapshot, non-generation commands)

**Files:**
- Create: `src/server/plugins/hub/index.ts`, `src/server/plugins/hub/generation.ts` (stubs only; Task 11 fills it), `test/worker/ws-helper.ts`
- Modify: `src/server/index.ts` (real `UserHub` + `/ws` route), `src/server/app.ts`, `src/server/cordis.d.ts`
- Test: `test/worker/hub-do.test.ts`

**Interfaces:**
- Consumes: Task 9 helpers, `createApp`, `WsCommand`/`WsEvent`.
- Produces:
  ```ts
  export interface InflightJob { message: Message; sessionId: number; controller: AbortController; startedAt: number; parts: Part[] }
  export class Hub extends Service {                    // ctx.hub
    readonly db: DB; readonly state: DurableObjectState; readonly app: Context   // owning context, for emit
    broadcast(event: WsEvent): void
    handleConnect(ws: WebSocket): void                   // sends snapshot
    handleCommand(raw: string): Promise<void>            // parse + dispatch + error event
    inflight(): InflightJob[]; trackInflight(job): Promise<void>; untrackInflight(messageId): Promise<void>
    ensureAlarm(): Promise<void>; onAlarm(): Promise<void>
    // generation entry points implemented in Task 11:
    send(cmd: SendCommand): Promise<void>; regenerate(cmd): Promise<void>; edit(cmd): Promise<void>; stop(cmd): Promise<void>
  }
  export const HubPlugin
  ```
  Events (declared in `cordis.d.ts`): `'session/created'(session: Session)`, `'session/updated'(session: Session)`, `'session/deleted'(id: number)`, `'message/before-send'(payload: BeforeSendPayload)`, `'message/done'(message: Message)`.
- `UserHub` DO exposes `get app(): Context` for tests.

- [ ] **Step 1: Write the failing test**

`test/worker/ws-helper.ts` (shared by the DO tests; not a test file itself):
```ts
import { exports } from 'cloudflare:workers'
import type { WsEvent } from '@/shared/ws'

export interface WsHarness {
  ws: WebSocket
  events: WsEvent[]
  /** Resolves with the first event of that type already received or the next one to arrive. */
  next: (type: WsEvent['type']) => Promise<WsEvent>
}

export async function connect(): Promise<WsHarness> {
  const res = await exports.default.fetch(new Request('https://x/ws', { headers: { Upgrade: 'websocket' } }))
  if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status}`)
  const ws = res.webSocket
  ws.accept()
  const events: WsEvent[] = []
  const waiters: Array<{ type: string; resolve: (e: WsEvent) => void }> = []
  ws.addEventListener('message', (ev) => {
    const e = JSON.parse(ev.data as string) as WsEvent
    events.push(e)
    for (const w of [...waiters]) if (w.type === e.type) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e) }
  })
  const next = (type: WsEvent['type']) => new Promise<WsEvent>((resolve, reject) => {
    const found = events.find((e) => e.type === type)
    if (found) return resolve(found)
    waiters.push({ type, resolve })
    setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000)
  })
  return { ws, events, next }
}
```

`test/worker/hub-do.test.ts`:
```ts
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { createSession } from '@/server/plugins/hub/sessions'
import { connect } from './ws-helper'

describe('UserHub DO', () => {
  it('sends a snapshot on connect and rejects non-upgrade requests', async () => {
    const plain = await exports.default.fetch(new Request('https://x/ws'))
    expect(plain.status).toBe(426)
    const { next } = await connect()
    const snap = await next('snapshot')
    expect(snap).toEqual({ type: 'snapshot', inflight: [] })
  })

  it('updates and deletes a session, broadcasting to two sockets', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const s = await createSession(db, { user_id: 1, title: 'old', provider_id: null, model_id: null })
    const a = await connect()
    const b = await connect()
    a.ws.send(JSON.stringify({ type: 'session.update', session_id: s.id, title: 'new', system_prompt: 'sys' }))
    const ea = await a.next('session.updated')
    const eb = await b.next('session.updated')
    expect(ea).toMatchObject({ type: 'session.updated', session: { id: s.id, title: 'new', system_prompt: 'sys' } })
    expect(eb).toEqual(ea)
    b.ws.send(JSON.stringify({ type: 'session.delete', session_id: s.id }))
    expect(await a.next('session.deleted')).toEqual({ type: 'session.deleted', session_id: s.id })
  })

  it('answers invalid commands with an error event carrying request_id', async () => {
    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'session.update', request_id: 'r9' }))
    const err = await next('error')
    expect(err).toMatchObject({ type: 'error', request_id: 'r9' })
    ws.send('not json')
    expect((await next('error')).type).toBe('error')
  })

  it('updates settings and broadcasts them', async () => {
    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'settings.update', settings: { plugins: { demo: true } } }))
    expect(await next('settings.updated')).toEqual({ type: 'settings.updated', settings: { plugins: { demo: true } } })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/worker/hub-do.test.ts`
Expected: FAIL (501 from the placeholder DO / missing module).

- [ ] **Step 3: Implement the Hub service**

`src/server/plugins/hub/index.ts`:
```ts
import { Context, Service } from 'cordis'
import { ZodError } from 'zod'
import type { DB } from '../../db/client'
import { DEFAULT_USER_ID, GENERATION_TIMEOUT_MS } from '@/shared/constants'
import type { Message, Session, UserSettings } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { encodeEvent, parseCommand, type SendCommand, type WsCommand, type WsEvent } from '@/shared/ws'
import {
  deleteSession, finalizeMessage, getMessage, getSession, getUser, toMessage, updateSession, updateUserSettings,
} from './sessions'
import { SeqAllocator } from './seq'
import { runEdit, runRegenerate, runSend } from './generation'

export interface InflightJob {
  message: Message
  sessionId: number
  controller: AbortController
  startedAt: number
  parts: Part[]
}

interface StoredInflight {
  message: Message
  parts: Part[]
  startedAt: number
}

const INFLIGHT_PREFIX = 'inflight:'

export class Hub extends Service {
  static readonly provide = 'hub'
  static readonly inject = ['env', 'doState', 'db', 'assets', 'llm']

  /** Owning context (this.ctx inside methods is the caller's context, per cordis semantics). */
  readonly app: Context
  readonly state: DurableObjectState
  readonly db: DB
  readonly seq = new SeqAllocator()
  private readonly _inflight = new Map<number, InflightJob>()

  constructor(ctx: Context) {
    super(ctx, 'hub')
    this.app = ctx
    this.state = ctx.doState
    this.db = ctx.db.orm
  }

  async [Service.init]() {
    await this._recoverInflight()
  }

  // ---- sockets

  broadcast(event: WsEvent): void {
    const raw = encodeEvent(event)
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(raw) } catch (err) { console.warn('ws send failed', err) }
    }
  }

  handleConnect(ws: WebSocket): void {
    ws.send(encodeEvent({ type: 'snapshot', inflight: this.inflight().map((j) => ({ ...j.message, parts: j.parts })) }))
  }

  async handleCommand(raw: string): Promise<void> {
    let cmd: WsCommand
    try {
      cmd = parseCommand(raw)
    } catch (err) {
      const requestId = safeRequestId(raw)
      this.broadcast({ type: 'error', request_id: requestId, message: err instanceof ZodError ? 'invalid command' : 'malformed json' })
      return
    }
    try {
      await this._dispatch(cmd)
    } catch (err) {
      console.error('command failed', cmd.type, err)
      this.broadcast({ type: 'error', request_id: cmd.request_id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  private async _dispatch(cmd: WsCommand): Promise<void> {
    switch (cmd.type) {
      case 'send': return runSend(this, cmd)
      case 'regenerate': return runRegenerate(this, cmd)
      case 'edit': return runEdit(this, cmd)
      case 'stop': return this.stop(cmd.session_id)
      case 'switch_head': return this.switchHead(cmd.session_id, cmd.message_id)
      case 'session.update': return this.sessionUpdate(cmd)
      case 'session.delete': return this.sessionDelete(cmd.session_id)
      case 'settings.update': return this.settingsUpdate(cmd.settings)
    }
  }

  // ---- non-generation commands

  async stop(sessionId: number): Promise<void> {
    for (const job of this._inflight.values()) if (job.sessionId === sessionId) job.controller.abort('user stopped')
  }

  async switchHead(sessionId: number, messageId: number): Promise<void> {
    const m = await getMessage(this.db, messageId)
    if (!m || m.session_id !== sessionId) throw new Error('message not in session')
    const s = await updateSession(this.db, sessionId, { head_message_id: messageId })
    this.broadcast({ type: 'head.changed', session_id: sessionId, message_id: messageId })
    this.emitSessionUpdated(s)
  }

  async sessionUpdate(cmd: Extract<WsCommand, { type: 'session.update' }>): Promise<void> {
    const { type: _t, request_id: _r, session_id, ...patch } = cmd
    if (!(await getSession(this.db, session_id))) throw new Error('session not found')
    const s = await updateSession(this.db, session_id, patch)
    this.emitSessionUpdated(s)
  }

  async sessionDelete(sessionId: number): Promise<void> {
    await this.stop(sessionId)
    await deleteSession(this.db, sessionId)
    this.seq.forget(sessionId)
    this.broadcast({ type: 'session.deleted', session_id: sessionId })
    this.app.emit('session/deleted', sessionId)
  }

  async settingsUpdate(patch: { plugins?: Record<string, boolean> }): Promise<void> {
    const user = await getUser(this.db, DEFAULT_USER_ID)
    if (!user) throw new Error('user missing')
    const settings: UserSettings = { plugins: { ...user.settings.plugins, ...(patch.plugins ?? {}) } }
    const updated = await updateUserSettings(this.db, DEFAULT_USER_ID, settings)
    this.broadcast({ type: 'settings.updated', settings: updated.settings })
    // Feature plugins toggled here would be loaded/disposed at this point; MVP ships none.
  }

  emitSessionCreated(s: Session): void {
    this.broadcast({ type: 'session.created', session: s })
    this.app.emit('session/created', s)
  }

  emitSessionUpdated(s: Session): void {
    this.broadcast({ type: 'session.updated', session: s })
    this.app.emit('session/updated', s)
  }

  // ---- inflight bookkeeping (used by generation.ts)

  inflight(): InflightJob[] {
    return [...this._inflight.values()]
  }

  async trackInflight(job: InflightJob): Promise<void> {
    this._inflight.set(job.message.id, job)
    await this.flushInflight(job)
    await this.ensureAlarm()
  }

  async flushInflight(job: InflightJob): Promise<void> {
    const stored: StoredInflight = { message: job.message, parts: job.parts, startedAt: job.startedAt }
    await this.state.storage.put(`${INFLIGHT_PREFIX}${job.message.id}`, stored)
  }

  async untrackInflight(messageId: number): Promise<void> {
    this._inflight.delete(messageId)
    await this.state.storage.delete(`${INFLIGHT_PREFIX}${messageId}`)
    if (this._inflight.size === 0) await this.state.storage.deleteAlarm()
  }

  async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + GENERATION_TIMEOUT_MS)
    }
  }

  async onAlarm(): Promise<void> {
    const now = Date.now()
    let earliest = Infinity
    for (const job of this._inflight.values()) {
      if (now - job.startedAt >= GENERATION_TIMEOUT_MS) job.controller.abort('timeout')
      else earliest = Math.min(earliest, job.startedAt)
    }
    if (earliest !== Infinity) await this.state.storage.setAlarm(earliest + GENERATION_TIMEOUT_MS)
  }

  /** A previous DO instance died mid-generation: persist what it had as aborted. */
  private async _recoverInflight(): Promise<void> {
    const stored = await this.state.storage.list<StoredInflight>({ prefix: INFLIGHT_PREFIX })
    for (const [key, job] of stored) {
      await finalizeMessage(this.db, job.message.id, { parts: job.parts, usage: null, status: 'aborted', error: 'interrupted' })
      await this.state.storage.delete(key)
    }
    await this.state.storage.deleteAlarm()
  }
}

function safeRequestId(raw: string): string | undefined {
  try {
    const v = JSON.parse(raw) as { request_id?: unknown }
    return typeof v.request_id === 'string' ? v.request_id : undefined
  } catch {
    return undefined
  }
}

export const HubPlugin = {
  name: 'hub',
  async apply(ctx: Context) {
    await ctx.plugin(Hub)
  },
}

export { toMessage }
```

Create `src/server/plugins/hub/generation.ts` with stubs so the module resolves (Task 11 fills them in):
```ts
import type { Hub } from './index'
import type { WsCommand, SendCommand } from '@/shared/ws'

export async function runSend(_hub: Hub, _cmd: SendCommand): Promise<void> {
  throw new Error('not implemented')
}
export async function runRegenerate(_hub: Hub, _cmd: Extract<WsCommand, { type: 'regenerate' }>): Promise<void> {
  throw new Error('not implemented')
}
export async function runEdit(_hub: Hub, _cmd: Extract<WsCommand, { type: 'edit' }>): Promise<void> {
  throw new Error('not implemented')
}
```

Append to `src/server/cordis.d.ts`:
```ts
import type { Hub } from './plugins/hub'
import type { Message, Session } from '@/shared/models'
import type { BeforeSendPayload } from './plugins/hub/generation'
declare module 'cordis' {
  interface Context {
    hub: Hub
  }
  interface Events {
    'session/created'(session: Session): void
    'session/updated'(session: Session): void
    'session/deleted'(sessionId: number): void
    'message/before-send'(payload: BeforeSendPayload): void
    'message/done'(message: Message): void
  }
}
```
Add `export interface BeforeSendPayload { sessionId: number; systemPrompt: string | null; path: Message[] }` to `generation.ts` now (Task 11 uses it).

In `src/server/app.ts`: `import { HubPlugin } from './plugins/hub'` and, after the Llm line, `if (options.side === 'hub') await ctx.plugin(HubPlugin)`.

- [ ] **Step 4: Implement the DO and the `/ws` route**

`src/server/index.ts`:
```ts
import { Hono } from 'hono'
import { DurableObject } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { createApp } from './app'
import { DEFAULT_USER_ID } from '@/shared/constants'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/ws', (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
  const stub = c.env.USER_HUB.getByName(String(DEFAULT_USER_ID))
  return stub.fetch(c.req.raw)
})

export default { fetch: app.fetch } satisfies ExportedHandler<Env>

export class UserHub extends DurableObject<Env> {
  private _app!: Context

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this._app = await createApp({ env, side: 'hub', doState: ctx })
    })
  }

  /** Exposed for tests (runInDurableObject). */
  get app(): Context {
    return this._app
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    this._app.hub.handleConnect(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    // Awaited on purpose: the generation must stay inside this event to keep the DO alive.
    await this._app.hub.handleCommand(message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason)
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('websocket error', error)
  }

  async alarm(): Promise<void> {
    await this._app.hub.onAlarm()
  }
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run test/worker/hub-do.test.ts test/worker/smoke.test.ts`
Expected: PASS (5 tests). If `ws.addEventListener` inside workerd tests does not deliver messages, switch the helper to `ws.onmessage = ...`; both are supported by workerd's WebSocket.

Run: `pnpm tsc -p tsconfig.worker.json --noEmit && pnpm tsc -p test/tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server test/worker/hub-do.test.ts
git commit -m "feat(hub): UserHub durable object with websocket hub and session commands"
```

---

### Task 11: Generation pipeline (send / regenerate / edit / stop / timeout)

**Files:**
- Modify: `src/server/plugins/hub/generation.ts`
- Test: `test/worker/hub-generation.test.ts`

**Interfaces:**
- Consumes: `Hub`, `buildModelMessages`, `buildProviderOptions`, `PartAccumulator`, `toUsage`, session ops, `ctx.llm.createModel`, `ctx.assets.getBytes`.
- Produces: `runSend`, `runRegenerate`, `runEdit`, `BeforeSendPayload`, `GenerationJob`.

Pipeline stages (spec §4.4): resolve target → persist user message → create assistant shell → assemble context → build messages → stream → finalize. Each is a function below; events are emitted at the boundaries.

- [ ] **Step 1: Write the failing test**

`test/worker/hub-generation.test.ts`:
```ts
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { listMessages } from '@/server/plugins/hub/sessions'
import { models, providers } from '@/server/db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'
import type { UserHub } from '@/server/index'
import { connect } from './ws-helper'

const STREAM = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'mock', timestamp: new Date(0) },
  { type: 'reasoning-start', id: 'r1' },
  { type: 'reasoning-delta', id: 'r1', delta: 'think' },
  { type: 'reasoning-end', id: 'r1', providerMetadata: { anthropic: { signature: 'SIG' } } },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Hello, ' },
  { type: 'text-delta', id: 't1', delta: 'world!' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 0 }, outputTokens: { total: 5, text: 3, reasoning: 2 }, raw: {} } },
] as const

async function seedProvider(): Promise<number> {
  const db = createDb(env.DB)
  await ensureDefaultUser(db)
  const [p] = await db.insert(providers).values({
    user_id: DEFAULT_USER_ID, name: 'mock', protocol: 'mock' as never, base_url: 'https://mock',
    api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'k'), extra: null, enabled: true, created_at: 0,
  }).returning()
  await db.insert(models).values({ provider_id: p!.id, model_id: 'mock-1', display_name: 'Mock', capabilities: { reasoning: true }, pricing: null, enabled: true, sort: 0 })
  return p!.id
}

async function installMock(mockFactory: () => MockLanguageModelV4): Promise<MockLanguageModelV4[]> {
  const created: MockLanguageModelV4[] = []
  const stub = env.USER_HUB.getByName(String(DEFAULT_USER_ID))
  await runInDurableObject(stub, async (instance: UserHub) => {
    await instance.app.plugin({
      name: 'mock-protocol',
      inject: ['llm'],
      apply(c) { c.llm.register('mock', () => { const m = mockFactory(); created.push(m); return m as never }) },
    })
  })
  return created
}

describe('generation', () => {
  it('streams a reply to every socket and persists it', async () => {
    const providerId = await seedProvider()
    const created = await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const a = await connect()
    const b = await connect()
    a.ws.send(JSON.stringify({ type: 'send', request_id: 'r1', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi there' }], provider_id: providerId, model_id: 'mock-1' }))
    const done = await a.next('message.done')
    expect(done).toMatchObject({ type: 'message.done', status: 'done', usage: { prompt: 10, completion: 5, cached: 2, reasoning: 2 }, error: null })

    const types = a.events.map((e) => e.type)
    expect(types.slice(0, 5)).toEqual(['snapshot', 'session.created', 'message.created', 'message.created', 'head.changed'])
    expect(types.filter((t) => t === 'message.delta')).toHaveLength(3)
    await b.next('message.done')
    expect(b.events.filter((e) => e.type === 'message.delta')).toEqual(a.events.filter((e) => e.type === 'message.delta'))

    const created1 = a.events.find((e) => e.type === 'session.created')!
    const sessionId = (created1 as { session: { id: number; title: string } }).session.id
    expect((created1 as { session: { title: string } }).session.title).toBe('hi there')
    const rows = await listMessages(createDb(env.DB), sessionId)
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(rows[1]!.parts).toEqual([
      { type: 'reasoning', text: 'think', providerOptions: { anthropic: { signature: 'SIG' } } },
      { type: 'text', text: 'Hello, world!' },
    ])
    expect(rows[1]!.status).toBe('done')
    expect(created[0]!.doStreamCalls[0]!.prompt.at(-1)).toMatchObject({ role: 'user' })
  })

  it('regenerate creates a sibling and moves the head; edit creates a sibling user message', async () => {
    const providerId = await seedProvider()
    await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: null, initialDelayInMs: null }) }),
    }))
    const c = await connect()
    c.ws.send(JSON.stringify({ type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'q' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.next('message.done')
    const firstAssistant = (c.events.filter((e) => e.type === 'message.created')[1] as { message: { id: number; session_id: number; parent_id: number } }).message
    c.events.length = 0
    c.ws.send(JSON.stringify({ type: 'regenerate', message_id: firstAssistant.id }))
    await c.next('message.done')
    const regen = (c.events.find((e) => e.type === 'message.created') as { message: { id: number; parent_id: number } }).message
    expect(regen.parent_id).toBe(firstAssistant.parent_id)
    expect(regen.id).not.toBe(firstAssistant.id)
    expect(c.events.find((e) => e.type === 'head.changed')).toMatchObject({ message_id: regen.id })

    c.events.length = 0
    c.ws.send(JSON.stringify({ type: 'edit', message_id: firstAssistant.parent_id, parts: [{ type: 'text', text: 'q2' }] }))
    await c.next('message.done')
    const createdMsgs = c.events.filter((e) => e.type === 'message.created') as Array<{ message: { role: string; parent_id: number | null; parts: unknown } }>
    expect(createdMsgs[0]!.message).toMatchObject({ role: 'user', parent_id: null, parts: [{ type: 'text', text: 'q2' }] })
    expect(createdMsgs[1]!.message.role).toBe('assistant')
  })

  it('stop aborts and keeps partial text', async () => {
    const providerId = await seedProvider()
    await installMock(() => new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [...STREAM], chunkDelayInMs: 200, initialDelayInMs: null }) }),
    }))
    const c = await connect()
    c.ws.send(JSON.stringify({ type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'slow' }], provider_id: providerId, model_id: 'mock-1' }))
    await c.next('message.delta')
    const sessionId = (c.events.find((e) => e.type === 'session.created') as { session: { id: number } }).session.id
    c.ws.send(JSON.stringify({ type: 'stop', session_id: sessionId }))
    const done = await c.next('message.done')
    expect(done).toMatchObject({ status: 'aborted' })
    const rows = await listMessages(createDb(env.DB), sessionId)
    expect(rows[1]!.status).toBe('aborted')
  })

  it('reports provider errors as status error', async () => {
    const providerId = await seedProvider()
    await installMock(() => new MockLanguageModelV4({ doStream: async () => { throw new Error('boom 401') } }))
    const c = await connect()
    c.ws.send(JSON.stringify({ type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'x' }], provider_id: providerId, model_id: 'mock-1' }))
    const done = await c.next('message.done')
    expect(done).toMatchObject({ status: 'error', error: expect.stringContaining('boom 401') })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/worker/hub-generation.test.ts`
Expected: FAIL with `not implemented` error events / timeouts.

- [ ] **Step 3: Implement generation.ts**

```ts
import { streamText, type LanguageModel } from 'ai'
import { INFLIGHT_FLUSH_INTERVAL_MS, DEFAULT_USER_ID } from '@/shared/constants'
import type { Message, PersistedStatus, SessionParams } from '@/shared/models'
import type { Part } from '@/shared/parts'
import type { SendCommand, WsCommand } from '@/shared/ws'
import type { ModelRow, ProviderRow, SessionRow } from '../../db/schema'
import { PartAccumulator } from '../llm/accumulator'
import { buildModelMessages, buildProviderOptions, type ImageBytes } from '../llm/messages'
import { toUsage } from '../llm/usage'
import type { Hub, InflightJob } from './index'
import {
  createSession, getAttachment, getMessage, getModel, getProvider, getSession, insertMessage, finalizeMessage,
  listMessages, maxSeq, toMessage, updateSession,
} from './sessions'
import { pathToRoot, titleFromParts } from './tree'

export interface BeforeSendPayload {
  sessionId: number
  systemPrompt: string | null
  /** Root → leaf; plugins may mutate (convention: only the last element). */
  path: Message[]
}

interface Target {
  session: SessionRow
  provider: ProviderRow
  model: ModelRow
}

// ---- stage 1: resolve session + model

async function resolveTarget(hub: Hub, sessionId: number | null, providerId: number | null, modelId: string | null, firstParts: Part[]): Promise<Target> {
  let session = sessionId === null ? undefined : await getSession(hub.db, sessionId)
  if (sessionId !== null && !session) throw new Error('session not found')
  const pid = providerId ?? session?.provider_id ?? null
  const mid = modelId ?? session?.model_id ?? null
  if (pid === null || mid === null) throw new Error('no model selected')
  const provider = await getProvider(hub.db, pid)
  if (!provider || !provider.enabled) throw new Error('provider not found')
  const model = await getModel(hub.db, pid, mid)
  if (!model) throw new Error('model not found')
  if (!session) {
    session = await createSession(hub.db, { user_id: DEFAULT_USER_ID, title: titleFromParts(firstParts), provider_id: pid, model_id: mid })
    hub.emitSessionCreated(session)
  } else if (session.provider_id !== pid || session.model_id !== mid) {
    session = await updateSession(hub.db, session.id, { provider_id: pid, model_id: mid })
    hub.emitSessionUpdated(session)
  }
  return { session, provider, model }
}

// ---- stage 2: persist a user message

async function persistUserMessage(hub: Hub, session: SessionRow, parentId: number | null, parts: Part[]): Promise<Message> {
  const seq = await hub.seq.allocate(session.id, () => maxSeq(hub.db, session.id))
  const row = await insertMessage(hub.db, {
    session_id: session.id, parent_id: parentId, seq, role: 'user', parts,
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: Date.now(),
  })
  const message = toMessage(row)
  hub.broadcast({ type: 'message.created', message })
  return message
}

// ---- stage 3: assistant shell (persisted as error until finalized) + head move

async function openAssistantShell(hub: Hub, target: Target, parentId: number): Promise<Message> {
  const seq = await hub.seq.allocate(target.session.id, () => maxSeq(hub.db, target.session.id))
  const row = await insertMessage(hub.db, {
    session_id: target.session.id, parent_id: parentId, seq, role: 'assistant', parts: [],
    provider_id: target.provider.id, model_id: target.model.model_id, usage: null, status: 'error', error: 'interrupted', created_at: Date.now(),
  })
  const message = toMessage(row, 'streaming')
  hub.broadcast({ type: 'message.created', message })
  const session = await updateSession(hub.db, target.session.id, { head_message_id: row.id })
  hub.broadcast({ type: 'head.changed', session_id: session.id, message_id: row.id })
  hub.emitSessionUpdated(session)
  return message
}

// ---- stage 4: context assembly

async function assembleContext(hub: Hub, session: SessionRow, leafUserId: number): Promise<{ path: Message[]; images: Map<number, ImageBytes> }> {
  const rows = await listMessages(hub.db, session.id)
  const byId = new Map(rows.map((r) => [r.id, toMessage(r)]))
  const path = pathToRoot(byId, leafUserId)
  const images = new Map<number, ImageBytes>()
  for (const m of path) for (const p of m.parts) {
    if (p.type !== 'image' || images.has(p.attachment_id)) continue
    const att = await getAttachment(hub.db, p.attachment_id)
    if (!att) throw new Error(`attachment ${p.attachment_id} missing`)
    const stored = await hub.app.assets.getBytes(att.r2_key)
    if (!stored) throw new Error(`attachment ${p.attachment_id} bytes missing`)
    images.set(p.attachment_id, { bytes: stored.bytes, mime: att.mime })
  }
  return { path, images }
}

// ---- stage 5/6: stream + finalize

async function generate(hub: Hub, target: Target, shell: Message, leafUserId: number): Promise<void> {
  const controller = new AbortController()
  const acc = new PartAccumulator()
  const job: InflightJob = { message: shell, sessionId: target.session.id, controller, startedAt: Date.now(), parts: acc.parts }
  await hub.trackInflight(job)

  let status: PersistedStatus = 'done'
  let error: string | null = null
  let usage = null as ReturnType<typeof toUsage>

  try {
    const { path, images } = await assembleContext(hub, target.session, leafUserId)
    const payload: BeforeSendPayload = { sessionId: target.session.id, systemPrompt: target.session.system_prompt, path }
    hub.app.emit('message/before-send', payload)

    const messages = buildModelMessages({ protocol: target.provider.protocol, systemPrompt: payload.systemPrompt, path: payload.path, images })
    const params: SessionParams = target.session.params ?? {}
    const model: LanguageModel = await hub.app.llm.createModel(target.provider, target.model)

    const result = streamText({
      model,
      messages,
      allowSystemInMessages: true,
      abortSignal: controller.signal,
      temperature: params.temperature,
      topP: params.top_p,
      maxOutputTokens: params.max_tokens,
      providerOptions: buildProviderOptions(target.provider.protocol, params, target.model.capabilities) as never,
    })

    let lastFlush = Date.now()
    for await (const part of result.stream) {
      if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(String(part.error))
      if (part.type === 'abort') { status = 'aborted'; break }
      if (part.type === 'finish') { usage = toUsage(part.totalUsage); continue }
      for (const ev of acc.apply(part)) {
        if (ev.kind === 'delta') hub.broadcast({ type: 'message.delta', message_id: shell.id, part_index: ev.part_index, kind: ev.part_kind, delta: ev.delta })
        else hub.broadcast({ type: 'message.part', message_id: shell.id, part_index: ev.part_index, part: ev.part })
      }
      if (Date.now() - lastFlush > INFLIGHT_FLUSH_INTERVAL_MS) { lastFlush = Date.now(); await hub.flushInflight(job) }
    }
    if (controller.signal.aborted) status = 'aborted'
  } catch (err) {
    if (controller.signal.aborted) {
      status = 'aborted'
    } else {
      status = 'error'
      error = err instanceof Error ? err.message : String(err)
      console.error('generation failed', err)
    }
  }

  await finalizeMessage(hub.db, shell.id, { parts: acc.parts, usage, status, error })
  await hub.untrackInflight(shell.id)
  const final: Message = { ...shell, parts: acc.parts, usage, status, error }
  hub.broadcast({ type: 'message.done', message_id: shell.id, status, usage, error })
  hub.app.emit('message/done', final)
}

// ---- entry points

export async function runSend(hub: Hub, cmd: SendCommand): Promise<void> {
  const target = await resolveTarget(hub, cmd.session_id, cmd.provider_id, cmd.model_id, cmd.parts)
  const parentId = cmd.session_id === null ? null : (cmd.parent_id ?? target.session.head_message_id)
  const user = await persistUserMessage(hub, target.session, parentId, cmd.parts)
  const shell = await openAssistantShell(hub, target, user.id)
  await generate(hub, target, shell, user.id)
}

export async function runRegenerate(hub: Hub, cmd: Extract<WsCommand, { type: 'regenerate' }>): Promise<void> {
  const old = await getMessage(hub.db, cmd.message_id)
  if (!old || old.role !== 'assistant' || old.parent_id === null) throw new Error('not an assistant message')
  const target = await resolveTarget(hub, old.session_id, cmd.provider_id ?? null, cmd.model_id ?? null, [])
  const shell = await openAssistantShell(hub, target, old.parent_id)
  await generate(hub, target, shell, old.parent_id)
}

export async function runEdit(hub: Hub, cmd: Extract<WsCommand, { type: 'edit' }>): Promise<void> {
  const old = await getMessage(hub.db, cmd.message_id)
  if (!old || old.role !== 'user') throw new Error('not a user message')
  const target = await resolveTarget(hub, old.session_id, null, null, cmd.parts)
  const user = await persistUserMessage(hub, target.session, old.parent_id, cmd.parts)
  const shell = await openAssistantShell(hub, target, user.id)
  await generate(hub, target, shell, user.id)
}
```

Notes for the implementer:
- `buildProviderOptions` must return `{}` for unknown protocols (the test registers `'mock'`); add `default: return {}` to its `switch` if TypeScript complains about exhaustiveness, keeping the four cases.
- The assistant shell is persisted with `status: 'error', error: 'interrupted'` so a DO death without recovery still leaves a truthful row; `finalizeMessage` overwrites it.
- `stop` must resolve `message.done` with `aborted`: the `abort` stream part or the thrown `AbortError` both lead there.
- The `for await` over `result.stream` runs inside the `webSocketMessage` event because `handleCommand` awaits `_dispatch`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/worker/hub-generation.test.ts`
Expected: PASS (4 tests). If the mock's `doStreamCalls[0].prompt` assertion fails on shape, log it once and fix the assertion to the real V4 prompt shape; the point is that the last message is the user turn.

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/plugins/hub test/worker/hub-generation.test.ts
git commit -m "feat(hub): streaming generation pipeline with regenerate, edit, stop and timeout"
```

---
### Task 12: REST API plugin and Worker wiring

**Files:**
- Create: `src/server/plugins/api/index.ts`, `src/server/plugins/api/me.ts`, `src/server/plugins/api/sessions.ts`, `src/server/plugins/api/providers.ts`, `src/server/plugins/api/models.ts`, `src/server/plugins/api/attachments.ts`
- Modify: `src/server/index.ts`, `src/server/app.ts`, `src/server/cordis.d.ts`
- Test: `test/worker/api.test.ts`

**Interfaces:**
- Produces: `ctx.api: Hono<{ Bindings: Env }>` mounted at `/`; routes per spec §9 plus `GET /api/presets` and `GET /api/health`. Provider DTOs never include `api_key`.
- Route table:
  | method | path | body → response |
  |---|---|---|
  | GET | /api/me | → `User` |
  | GET | /api/presets | → `PresetProvider[]` |
  | GET | /api/sessions | → `Session[]` |
  | GET | /api/sessions/:id/messages | → `Message[]` |
  | GET | /api/providers | → `Provider[]` |
  | POST | /api/providers | `ProviderInput` → `Provider` (201) |
  | PUT | /api/providers/:id | `Partial<ProviderInput>` → `Provider` |
  | DELETE | /api/providers/:id | → 204 |
  | POST | /api/providers/:id/fetch-models | → `FetchModelsResponse` |
  | GET | /api/providers/:id/models | → `Model[]` |
  | POST | /api/providers/:id/models | `ModelInput` → `Model` (201) |
  | PUT | /api/providers/:id/models/:modelRowId | `Partial<ModelInput>` → `Model` |
  | DELETE | /api/providers/:id/models/:modelRowId | → 204 |
  | POST | /api/attachments/check | `{ sha256 }` → `AttachmentCheckResponse` |
  | PUT | /api/attachments/:sha256?w=&h= | raw bytes, `Content-Type` → `AttachmentUploadResponse` (201) |
  | GET | /api/attachments/:id | → bytes with `Cache-Control: private, max-age=31536000, immutable` |
  | GET | /ws | upgrade → DO |

- [ ] **Step 1: Write the failing test**

`test/worker/api.test.ts`:
```ts
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const json = (method: string, path: string, body?: unknown) =>
  exports.default.fetch(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))

describe('REST api', () => {
  it('returns the default user', async () => {
    const res = await json('GET', '/api/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 1, settings: { plugins: {} } })
  })

  it('creates a provider without leaking the key, lists models, deletes', async () => {
    const created = await json('POST', '/api/providers', { name: 'A', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_key: 'sk-secret' })
    expect(created.status).toBe(201)
    const p = (await created.json()) as { id: number; has_key: boolean; api_key?: string }
    expect(p.has_key).toBe(true)
    expect(p.api_key).toBeUndefined()

    const m = await json('POST', `/api/providers/${p.id}/models`, { model_id: 'claude-x', display_name: 'Claude X', capabilities: { vision: true } })
    expect(m.status).toBe(201)
    const list = await (await json('GET', `/api/providers/${p.id}/models`)).json() as Array<{ model_id: string }>
    expect(list.map((x) => x.model_id)).toEqual(['claude-x'])

    const upd = await json('PUT', `/api/providers/${p.id}`, { name: 'B' })
    expect((await upd.json() as { name: string; has_key: boolean })).toMatchObject({ name: 'B', has_key: true })

    expect((await json('DELETE', `/api/providers/${p.id}`)).status).toBe(204)
    const after = await (await json('GET', '/api/providers')).json() as Array<{ id: number }>
    expect(after.find((x) => x.id === p.id)).toBeUndefined()
  })

  it('validates provider input', async () => {
    const res = await json('POST', '/api/providers', { name: '', protocol: 'nope', base_url: 'x' })
    expect(res.status).toBe(400)
  })

  it('uploads, dedupes and serves an attachment', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const check1 = await (await json('POST', '/api/attachments/check', { sha256: sha })).json() as { exists: boolean }
    expect(check1.exists).toBe(false)
    const up = await exports.default.fetch(new Request(`https://x/api/attachments/${sha}?w=2&h=2`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes }))
    expect(up.status).toBe(201)
    const { attachment_id } = (await up.json()) as { attachment_id: number }
    const check2 = await (await json('POST', '/api/attachments/check', { sha256: sha })).json() as { exists: boolean; attachment_id: number }
    expect(check2).toEqual({ exists: true, attachment_id })
    const got = await exports.default.fetch(new Request(`https://x/api/attachments/${attachment_id}`))
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes)
  })

  it('rejects an upload whose hash does not match', async () => {
    const res = await exports.default.fetch(new Request(`https://x/api/attachments/${'0'.repeat(64)}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([9]) }))
    expect(res.status).toBe(400)
  })

  it('lists sessions and messages', async () => {
    const res = await json('GET', '/api/sessions')
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
    expect((await json('GET', '/api/sessions/999999/messages')).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/worker/api.test.ts`
Expected: FAIL (404s).

- [ ] **Step 3: Implement the routes**

`src/server/plugins/api/index.ts`:
```ts
import { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { meRoutes } from './me'
import { sessionRoutes } from './sessions'
import { providerRoutes } from './providers'
import { modelRoutes } from './models'
import { attachmentRoutes } from './attachments'

export type ApiApp = Hono<{ Bindings: Env }>

export const ApiPlugin = {
  name: 'api',
  inject: ['env', 'db', 'assets'],
  apply(ctx: Context) {
    const app: ApiApp = new Hono()
    app.get('/api/health', (c) => c.json({ ok: true }))
    app.get('/ws', (c) => {
      if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
      return c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).fetch(c.req.raw)
    })
    app.route('/api', meRoutes(ctx))
    app.route('/api', sessionRoutes(ctx))
    app.route('/api', providerRoutes(ctx))
    app.route('/api', modelRoutes(ctx))
    app.route('/api', attachmentRoutes(ctx))
    app.onError((err, c) => {
      console.error('api error', err)
      return c.json({ error: err.message }, 500)
    })
    ctx.provide('api', app)
  },
}
```

`src/server/plugins/api/me.ts`:
```ts
import type { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { getUser } from '../hub/sessions'
import { PRESET_PROVIDERS } from '../llm/presets'

export function meRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  r.get('/me', async (c) => {
    const user = await getUser(ctx.db.orm, DEFAULT_USER_ID)
    return user ? c.json(user) : c.json({ error: 'no user' }, 500)
  })
  r.get('/presets', (c) => c.json(PRESET_PROVIDERS))
  return r
}
```

`src/server/plugins/api/sessions.ts`:
```ts
import type { Context } from 'cordis'
import { Hono } from 'hono'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { getSession, listMessages, listSessions, toMessage } from '../hub/sessions'

export function sessionRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  r.get('/sessions', async (c) => c.json(await listSessions(ctx.db.orm, DEFAULT_USER_ID)))
  r.get('/sessions/:id/messages', async (c) => {
    const id = Number(c.req.param('id'))
    const s = await getSession(ctx.db.orm, id)
    if (!s || s.user_id !== DEFAULT_USER_ID) return c.json({ error: 'not found' }, 404)
    const rows = await listMessages(ctx.db.orm, id)
    return c.json(rows.map((row) => toMessage(row)))
  })
  return r
}
```

`src/server/plugins/api/providers.ts`:
```ts
import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { ProviderInputSchema } from '@/shared/api'
import type { Provider } from '@/shared/models'
import { models, providers, type ProviderRow } from '../../db/schema'
import { decryptSecret, encryptSecret } from '../llm/crypto'
import { listRemoteModels } from '../llm/list-models'

export function toProviderDto(row: ProviderRow): Provider {
  const { api_key, ...rest } = row
  return { ...rest, has_key: api_key !== null }
}

export function providerRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm
  const secret = ctx.env.KEY_ENCRYPTION_SECRET
  const owned = (id: number) => and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID))

  r.get('/providers', async (c) => {
    const rows = await db.select().from(providers).where(eq(providers.user_id, DEFAULT_USER_ID)).orderBy(providers.id)
    return c.json(rows.map(toProviderDto))
  })

  r.post('/providers', async (c) => {
    const parsed = ProviderInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const { api_key, ...input } = parsed.data
    const [row] = await db.insert(providers).values({
      user_id: DEFAULT_USER_ID, name: input.name, protocol: input.protocol, base_url: input.base_url,
      api_key: api_key ? await encryptSecret(secret, api_key) : null,
      extra: input.extra ?? null, enabled: input.enabled ?? true, created_at: Date.now(),
    }).returning()
    return c.json(toProviderDto(row!), 201)
  })

  r.put('/providers/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const parsed = ProviderInputSchema.partial().safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const { api_key, ...patch } = parsed.data
    const set: Partial<ProviderRow> = { ...patch }
    if (api_key !== undefined) set.api_key = api_key === '' ? null : await encryptSecret(secret, api_key)
    const [row] = await db.update(providers).set(set).where(owned(id)).returning()
    return row ? c.json(toProviderDto(row)) : c.json({ error: 'not found' }, 404)
  })

  r.delete('/providers/:id', async (c) => {
    const id = Number(c.req.param('id'))
    await db.delete(providers).where(owned(id))
    return c.body(null, 204)
  })

  r.post('/providers/:id/fetch-models', async (c) => {
    const id = Number(c.req.param('id'))
    const row = await db.query.providers.findFirst({ where: owned(id) })
    if (!row) return c.json({ error: 'not found' }, 404)
    const key = row.api_key ? await decryptSecret(secret, row.api_key) : null
    const ids = await listRemoteModels(row, key)
    let imported = 0
    for (const model_id of ids) {
      const res = await db.insert(models)
        .values({ provider_id: id, model_id, display_name: model_id, capabilities: {}, pricing: null, enabled: true, sort: 0 })
        .onConflictDoNothing().returning({ id: models.id })
      if (res.length > 0) imported++
    }
    return c.json({ imported, models: ids })
  })

  return r
}
```

`src/server/plugins/api/models.ts`:
```ts
import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { ModelInputSchema } from '@/shared/api'
import { models, providers } from '../../db/schema'

export function modelRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm

  async function ownsProvider(id: number): Promise<boolean> {
    const p = await db.query.providers.findFirst({ where: and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID)) })
    return p !== undefined
  }

  r.get('/providers/:id/models', async (c) => {
    const pid = Number(c.req.param('id'))
    if (!(await ownsProvider(pid))) return c.json({ error: 'not found' }, 404)
    return c.json(await db.select().from(models).where(eq(models.provider_id, pid)).orderBy(models.sort, models.id))
  })

  r.post('/providers/:id/models', async (c) => {
    const pid = Number(c.req.param('id'))
    if (!(await ownsProvider(pid))) return c.json({ error: 'not found' }, 404)
    const parsed = ModelInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const i = parsed.data
    const [row] = await db.insert(models).values({
      provider_id: pid, model_id: i.model_id, display_name: i.display_name ?? i.model_id,
      capabilities: i.capabilities ?? {}, pricing: i.pricing ?? null, enabled: i.enabled ?? true, sort: i.sort ?? 0,
    }).onConflictDoUpdate({
      target: [models.provider_id, models.model_id],
      set: { display_name: i.display_name ?? i.model_id, capabilities: i.capabilities ?? {}, pricing: i.pricing ?? null, enabled: i.enabled ?? true, sort: i.sort ?? 0 },
    }).returning()
    return c.json(row, 201)
  })

  r.put('/providers/:id/models/:modelRowId', async (c) => {
    const pid = Number(c.req.param('id'))
    const mid = Number(c.req.param('modelRowId'))
    if (!(await ownsProvider(pid))) return c.json({ error: 'not found' }, 404)
    const parsed = ModelInputSchema.partial().safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    const [row] = await db.update(models).set(parsed.data).where(and(eq(models.id, mid), eq(models.provider_id, pid))).returning()
    return row ? c.json(row) : c.json({ error: 'not found' }, 404)
  })

  r.delete('/providers/:id/models/:modelRowId', async (c) => {
    const pid = Number(c.req.param('id'))
    const mid = Number(c.req.param('modelRowId'))
    if (!(await ownsProvider(pid))) return c.json({ error: 'not found' }, 404)
    await db.delete(models).where(and(eq(models.id, mid), eq(models.provider_id, pid)))
    return c.body(null, 204)
  })

  return r
}
```

`src/server/plugins/api/attachments.ts`:
```ts
import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { AttachmentCheckRequestSchema } from '@/shared/api'
import { attachments } from '../../db/schema'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function r2Key(userId: number, sha256: string): string {
  return `${userId}/${sha256.slice(0, 2)}/${sha256}`
}

export function attachmentRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm

  r.post('/attachments/check', async (c) => {
    const parsed = AttachmentCheckRequestSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input' }, 400)
    const row = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, DEFAULT_USER_ID), eq(attachments.sha256, parsed.data.sha256)) })
    return c.json(row ? { exists: true, attachment_id: row.id } : { exists: false })
  })

  r.put('/attachments/:sha256', async (c) => {
    const claimed = c.req.param('sha256')
    const mime = c.req.header('content-type') ?? ''
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return c.json({ error: 'unsupported mime' }, 415)
    const bytes = await c.req.arrayBuffer()
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: 'bad size' }, 400)
    const actual = hex(await crypto.subtle.digest('SHA-256', bytes))
    if (actual !== claimed) return c.json({ error: 'sha256 mismatch' }, 400)

    const existing = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, DEFAULT_USER_ID), eq(attachments.sha256, actual)) })
    if (existing) return c.json({ attachment_id: existing.id }, 201)

    const key = r2Key(DEFAULT_USER_ID, actual)
    await ctx.assets.put(key, bytes, mime)
    const w = Number(c.req.query('w')) || null
    const h = Number(c.req.query('h')) || null
    const [row] = await db.insert(attachments).values({
      user_id: DEFAULT_USER_ID, sha256: actual, mime, size: bytes.byteLength, width: w, height: h,
      r2_key: key, origin: 'upload', created_at: Date.now(),
    }).returning()
    return c.json({ attachment_id: row!.id }, 201)
  })

  r.get('/attachments/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const row = await db.query.attachments.findFirst({ where: and(eq(attachments.id, id), eq(attachments.user_id, DEFAULT_USER_ID)) })
    if (!row) return c.json({ error: 'not found' }, 404)
    const stored = await ctx.assets.getStream(row.r2_key)
    if (!stored) return c.json({ error: 'object missing' }, 404)
    return new Response(stored.body, {
      headers: { 'content-type': row.mime, 'content-length': String(stored.size), 'cache-control': 'private, max-age=31536000, immutable' },
    })
  })

  return r
}
```

Append to `src/server/cordis.d.ts`:
```ts
import type { ApiApp } from './plugins/api'
declare module 'cordis' {
  interface Context {
    api: ApiApp
  }
}
```

In `src/server/app.ts`: `import { ApiPlugin } from './plugins/api'` and `if (options.side === 'worker') await ctx.plugin(ApiPlugin)`.

Replace the Hono block in `src/server/index.ts` with a lazy per-isolate root:
```ts
import { DurableObject } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { createApp } from './app'

let workerApp: Promise<Context> | undefined

export default {
  async fetch(request, env, execCtx) {
    workerApp ??= createApp({ env, side: 'worker' })
    const ctx = await workerApp
    return ctx.api.fetch(request, env, execCtx)
  },
} satisfies ExportedHandler<Env>

// UserHub class unchanged from Task 10
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/worker/api.test.ts test/worker/hub-do.test.ts test/worker/smoke.test.ts`
Expected: PASS. Note `/api/health` moved into the api plugin, so the smoke test still passes.

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server test/worker/api.test.ts
git commit -m "feat(api): REST routes for sessions, providers, models and attachments"
```

---

### Task 13: Client foundation — Tailwind/shadcn, router, API client, WebSocket client, sync store

**Files:**
- Create: `components.json`, `src/client/lib/utils.ts` (from shadcn init), `src/client/ui/*` (shadcn add), `src/client/styles/main.scss`, `src/client/router.ts`, `src/client/lib/api.ts`, `src/client/lib/ws-client.ts`, `src/client/stores/sync.ts`, `src/client/stores/config.ts`, `src/client/components/app-shell.vue`, placeholder views
- Modify: `src/client/main.ts`, `src/client/app.vue`, `src/client/style.css`
- Test: `test/unit/client-sync-store.test.ts`, `test/unit/client-ws-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lib/api.ts
  export const api = { me(), presets(), sessions(), messages(sessionId), providers(), createProvider(input), updateProvider(id, input), deleteProvider(id), fetchModels(providerId), models(providerId), createModel(providerId, input), updateModel(providerId, rowId, input), deleteModel(providerId, rowId), checkAttachment(sha256), uploadAttachment(sha256, blob, w, h), attachmentUrl(id) }
  // lib/ws-client.ts
  export type WsStatus = 'connecting' | 'open' | 'closed'
  export class WsClient { constructor(url: string, handlers: { onEvent(e: WsEvent): void; onStatus(s: WsStatus): void }, opts?: { socketFactory?: (url: string) => WebSocket; minDelayMs?: number; maxDelayMs?: number }); connect(): void; close(): void; send(cmd: WsCommand): void }
  // stores/sync.ts
  useSyncStore(): { status, sessions: Map<number, Session>, messages: Map<number, Map<number, Message>>, streamingIds: Set<number>, settings, sessionList (sorted), applyEvent(e), loadSessions(), loadMessages(id), pathFor(sessionId): Message[], siblingsOf(sessionId, messageId): Message[], connect(), send(cmd) }
  ```

- [ ] **Step 1: Tailwind + shadcn init**

The CLI expects `src/style.css` to exist with the Tailwind import, so create it first (it is moved afterwards):
```bash
printf '@import "tailwindcss";\n' > src/style.css
export NODE_OPTIONS=--use-env-proxy https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897
pnpm dlx shadcn-vue@latest init -d -t vite -b neutral --css-variables -y
```
The CLI rewrites `src/style.css` and writes `components.json`, `src/lib/utils.ts`. Then:
1. Move `src/style.css` → `src/client/style.css` (overwrite the Task 1 file) and `src/lib/utils.ts` → `src/client/lib/utils.ts`; delete `src/lib`.
2. Edit `components.json`: `"tailwind.css": "src/client/style.css"`, aliases `"components": "@/client/components"`, `"utils": "@/client/lib/utils"`, `"ui": "@/client/ui"`, `"lib": "@/client/lib"`, `"composables": "@/client/composables"`.
3. In `src/client/style.css` remove any Google Fonts `@import url(...)` line and add after the tailwind imports:
   ```css
   @import "markstream-vue/index.tailwind.css" layer(components);
   ```
4. Add components:
   ```bash
   pnpm dlx shadcn-vue@latest add button input textarea select switch dialog sheet scroll-area separator label
   ```
   Expected: files under `src/client/ui/<name>/`, imports rewritten to `@/client/ui/...` and `@/client/lib/utils`.
5. If `pnpm-workspace.yaml` appeared, delete it.

`src/client/styles/main.scss` (explicit classes only — never bare element selectors, they beat Tailwind layers):
```scss
.oc-scroll {
  scrollbar-width: thin;
}
.oc-message-user {
  border-radius: 1rem 1rem 0.25rem 1rem;
}
```

- [ ] **Step 2: Write failing tests for the store and the ws client**

`test/unit/client-ws-client.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { WsClient } from '@/client/lib/ws-client'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
}

describe('WsClient', () => {
  it('connects, forwards events, queues sends until open, reconnects with backoff', async () => {
    vi.useFakeTimers()
    FakeSocket.instances = []
    const events: unknown[] = []
    const statuses: string[] = []
    const client = new WsClient('/ws', { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) }, {
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket, minDelayMs: 100, maxDelayMs: 400,
    })
    client.connect()
    client.send({ type: 'stop', session_id: 1 })
    const s1 = FakeSocket.instances[0]!
    expect(s1.sent).toEqual([])
    s1.open()
    expect(s1.sent).toEqual([JSON.stringify({ type: 'stop', session_id: 1 })])
    s1.onmessage?.({ data: JSON.stringify({ type: 'session.deleted', session_id: 3 }) })
    expect(events).toEqual([{ type: 'session.deleted', session_id: 3 }])

    s1.close()
    expect(statuses.at(-1)).toBe('closed')
    vi.advanceTimersByTime(100)
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.instances[1]!.close()
    vi.advanceTimersByTime(199)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)
    client.close()
    vi.advanceTimersByTime(10_000)
    expect(FakeSocket.instances).toHaveLength(3)
    vi.useRealTimers()
  })
})
```

`test/unit/client-sync-store.test.ts`:
```ts
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSyncStore } from '@/client/stores/sync'
import type { Message, Session } from '@/shared/models'

const session: Session = { id: 1, user_id: 1, title: 't', head_message_id: null, provider_id: null, model_id: null, system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null }
const msg = (id: number, parent_id: number | null, role: 'user' | 'assistant', over: Partial<Message> = {}): Message =>
  ({ id, session_id: 1, parent_id, seq: id, role, parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, ...over })

describe('sync store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('applies session and message events idempotently', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'session.created', session })
    expect(s.sessionList).toHaveLength(1)
    s.applyEvent({ type: 'message.created', message: msg(1, null, 'user') })
    s.applyEvent({ type: 'message.created', message: msg(2, 1, 'assistant', { status: 'streaming' }) })
    s.applyEvent({ type: 'head.changed', session_id: 1, message_id: 2 })
    expect(s.streamingIds.has(2)).toBe(true)
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 0, kind: 'reasoning', delta: 'hm' })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 1, kind: 'text', delta: 'Hi' })
    s.applyEvent({ type: 'message.delta', message_id: 2, part_index: 1, kind: 'text', delta: '!' })
    expect(s.messages.get(1)!.get(2)!.parts).toEqual([{ type: 'reasoning', text: 'hm' }, { type: 'text', text: 'Hi!' }])
    s.applyEvent({ type: 'message.done', message_id: 2, status: 'done', usage: { prompt: 1 }, error: null })
    expect(s.messages.get(1)!.get(2)).toMatchObject({ status: 'done', usage: { prompt: 1 } })
    expect(s.streamingIds.has(2)).toBe(false)
    expect(s.pathFor(1).map((m) => m.id)).toEqual([1, 2])
  })

  it('keeps streaming state when REST data arrives with a stale status', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.applyEvent({ type: 'snapshot', inflight: [msg(5, 4, 'assistant', { status: 'streaming', parts: [{ type: 'text', text: 'partial' }] })] })
    s.ingestMessages(1, [msg(4, null, 'user'), msg(5, 4, 'assistant', { status: 'error', error: 'interrupted' })])
    expect(s.messages.get(1)!.get(5)).toMatchObject({ status: 'streaming', parts: [{ type: 'text', text: 'partial' }] })
  })

  it('computes siblings for the branch switcher', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.ingestMessages(1, [msg(1, null, 'user'), msg(2, 1, 'assistant'), msg(3, 1, 'assistant')])
    expect(s.siblingsOf(1, 3).map((m) => m.id)).toEqual([2, 3])
  })

  it('removes a deleted session and its messages', () => {
    const s = useSyncStore()
    s.applyEvent({ type: 'session.created', session })
    s.ingestMessages(1, [msg(1, null, 'user')])
    s.applyEvent({ type: 'session.deleted', session_id: 1 })
    expect(s.sessions.size).toBe(0)
    expect(s.messages.has(1)).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/client-ws-client.test.ts test/unit/client-sync-store.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement lib and stores**

`src/client/lib/api.ts`:
```ts
import type { AttachmentCheckResponse, AttachmentUploadResponse, FetchModelsResponse, ModelInput, ProviderInput } from '@/shared/api'
import type { Message, Model, Provider, Session, User } from '@/shared/models'
import type { PresetProvider } from '@/server/plugins/llm/presets'

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body instanceof Blob ? init.headers : { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    ...init,
  })
  if (!res.ok) {
    let detail = ''
    try { detail = ((await res.json()) as { error?: string }).error ?? '' } catch { /* ignore */ }
    throw new Error(`${method} ${path} failed: ${res.status} ${detail}`.trim())
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const api = {
  me: () => request<User>('GET', '/api/me'),
  presets: () => request<PresetProvider[]>('GET', '/api/presets'),
  sessions: () => request<Session[]>('GET', '/api/sessions'),
  messages: (sessionId: number) => request<Message[]>('GET', `/api/sessions/${sessionId}/messages`),
  providers: () => request<Provider[]>('GET', '/api/providers'),
  createProvider: (input: ProviderInput) => request<Provider>('POST', '/api/providers', input),
  updateProvider: (id: number, input: Partial<ProviderInput>) => request<Provider>('PUT', `/api/providers/${id}`, input),
  deleteProvider: (id: number) => request<void>('DELETE', `/api/providers/${id}`),
  fetchModels: (providerId: number) => request<FetchModelsResponse>('POST', `/api/providers/${providerId}/fetch-models`),
  models: (providerId: number) => request<Model[]>('GET', `/api/providers/${providerId}/models`),
  createModel: (providerId: number, input: ModelInput) => request<Model>('POST', `/api/providers/${providerId}/models`, input),
  updateModel: (providerId: number, rowId: number, input: Partial<ModelInput>) => request<Model>('PUT', `/api/providers/${providerId}/models/${rowId}`, input),
  deleteModel: (providerId: number, rowId: number) => request<void>('DELETE', `/api/providers/${providerId}/models/${rowId}`),
  checkAttachment: (sha256: string) => request<AttachmentCheckResponse>('POST', '/api/attachments/check', { sha256 }),
  uploadAttachment: (sha256: string, blob: Blob, w: number, h: number) =>
    request<AttachmentUploadResponse>('PUT', `/api/attachments/${sha256}?w=${w}&h=${h}`, blob, { headers: { 'content-type': blob.type } }),
  attachmentUrl: (id: number) => `/api/attachments/${id}`,
}
```

`src/client/lib/ws-client.ts`:
```ts
import { WsEventSchema, type WsCommand, type WsEvent } from '@/shared/ws'

export type WsStatus = 'connecting' | 'open' | 'closed'

export interface WsHandlers {
  onEvent(event: WsEvent): void
  onStatus(status: WsStatus): void
}

export interface WsOptions {
  socketFactory?: (url: string) => WebSocket
  minDelayMs?: number
  maxDelayMs?: number
  pingIntervalMs?: number
}

/** Single WebSocket with exponential-backoff reconnect and a send queue. No Vue dependency. */
export class WsClient {
  private _socket: WebSocket | null = null
  private _queue: string[] = []
  private _attempt = 0
  private _closedByUser = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly _factory: (url: string) => WebSocket
  private readonly _min: number
  private readonly _max: number
  private readonly _ping: number

  constructor(private readonly _url: string, private readonly _handlers: WsHandlers, opts: WsOptions = {}) {
    this._factory = opts.socketFactory ?? ((url) => new WebSocket(url))
    this._min = opts.minDelayMs ?? 1000
    this._max = opts.maxDelayMs ?? 30_000
    this._ping = opts.pingIntervalMs ?? 30_000
  }

  connect(): void {
    this._closedByUser = false
    this._open()
  }

  close(): void {
    this._closedByUser = true
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._stopPing()
    this._socket?.close()
    this._socket = null
  }

  send(cmd: WsCommand): void {
    const raw = JSON.stringify(cmd)
    if (this._socket && this._socket.readyState === 1) this._socket.send(raw)
    else this._queue.push(raw)
  }

  private _open(): void {
    this._handlers.onStatus('connecting')
    const ws = this._factory(this._resolveUrl())
    this._socket = ws
    ws.onopen = () => {
      this._attempt = 0
      this._handlers.onStatus('open')
      for (const raw of this._queue.splice(0)) ws.send(raw)
      this._startPing(ws)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return
      const parsed = WsEventSchema.safeParse(JSON.parse(ev.data))
      if (parsed.success) this._handlers.onEvent(parsed.data)
      else console.warn('unknown ws event', ev.data)
    }
    ws.onerror = () => { /* onclose follows */ }
    ws.onclose = () => {
      this._stopPing()
      if (this._socket !== ws) return
      this._socket = null
      this._handlers.onStatus('closed')
      if (!this._closedByUser) this._scheduleReconnect()
    }
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(this._max, this._min * 2 ** this._attempt)
    this._attempt++
    this._reconnectTimer = setTimeout(() => this._open(), delay)
  }

  private _startPing(ws: WebSocket): void {
    this._pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('ping') }, this._ping)
  }

  private _stopPing(): void {
    if (this._pingTimer) clearInterval(this._pingTimer)
    this._pingTimer = null
  }

  private _resolveUrl(): string {
    if (/^wss?:/.test(this._url)) return this._url
    if (typeof location === 'undefined') return this._url
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}${this._url}`
  }
}
```

`src/client/stores/sync.ts`:
```ts
import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import { WsClient, type WsStatus } from '@/client/lib/ws-client'
import type { Message, Session, UserSettings } from '@/shared/models'
import type { Part } from '@/shared/parts'
import type { WsCommand, WsEvent } from '@/shared/ws'

function pathToRoot(byId: Map<number, Message>, headId: number | null): Message[] {
  const out: Message[] = []
  let cur = headId === null ? undefined : byId.get(headId)
  const seen = new Set<number>()
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.push(cur); cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id) }
  return out.reverse()
}

export const useSyncStore = defineStore('sync', () => {
  const status = ref<WsStatus>('closed')
  const sessions = reactive(new Map<number, Session>())
  const messages = reactive(new Map<number, Map<number, Message>>())
  const streamingIds = reactive(new Set<number>())
  const settings = ref<UserSettings>({ plugins: {} })
  const lastError = ref<string | null>(null)
  const client = shallowRef<WsClient | null>(null)

  const sessionList = computed(() => [...sessions.values()].sort((a, b) => b.updated_at - a.updated_at))

  function bucket(sessionId: number): Map<number, Message> {
    let b = messages.get(sessionId)
    if (!b) { b = reactive(new Map<number, Message>()); messages.set(sessionId, b) }
    return b
  }

  function findMessage(id: number): Message | undefined {
    for (const b of messages.values()) { const m = b.get(id); if (m) return m }
    return undefined
  }

  function upsertMessage(m: Message): void {
    const b = bucket(m.session_id)
    const existing = b.get(m.id)
    if (existing && streamingIds.has(m.id) && m.status !== 'streaming') {
      // A stale REST row must not clobber a live stream.
      return
    }
    b.set(m.id, { ...m, parts: m.parts.map((p) => ({ ...p })) })
    if (m.status === 'streaming') streamingIds.add(m.id)
  }

  function ingestMessages(sessionId: number, rows: Message[]): void {
    for (const r of rows) upsertMessage({ ...r, session_id: sessionId })
  }

  function applyEvent(e: WsEvent): void {
    switch (e.type) {
      case 'snapshot':
        for (const m of e.inflight) { streamingIds.add(m.id); bucket(m.session_id).set(m.id, m) }
        break
      case 'session.created':
      case 'session.updated':
        sessions.set(e.session.id, e.session)
        break
      case 'session.deleted':
        sessions.delete(e.session_id)
        messages.delete(e.session_id)
        break
      case 'message.created':
        upsertMessage(e.message)
        break
      case 'message.delta': {
        const m = findMessage(e.message_id)
        if (!m) return
        const parts = m.parts as Part[]
        while (parts.length <= e.part_index) parts.push({ type: e.kind, text: '' } as Part)
        const p = parts[e.part_index]!
        if (p.type === 'text' || p.type === 'reasoning') p.text += e.delta
        break
      }
      case 'message.part': {
        const m = findMessage(e.message_id)
        if (!m) return
        while (m.parts.length <= e.part_index) m.parts.push({ type: 'text', text: '' })
        m.parts[e.part_index] = e.part
        break
      }
      case 'message.done': {
        const m = findMessage(e.message_id)
        if (m) { m.status = e.status; m.usage = e.usage; m.error = e.error }
        streamingIds.delete(e.message_id)
        break
      }
      case 'head.changed': {
        const s = sessions.get(e.session_id)
        if (s) s.head_message_id = e.message_id
        break
      }
      case 'settings.updated':
        settings.value = e.settings
        break
      case 'error':
        lastError.value = e.message
        break
    }
  }

  function pathFor(sessionId: number): Message[] {
    const s = sessions.get(sessionId)
    const b = messages.get(sessionId)
    if (!s || !b) return []
    return pathToRoot(b as Map<number, Message>, s.head_message_id)
  }

  function siblingsOf(sessionId: number, messageId: number): Message[] {
    const b = messages.get(sessionId)
    const m = b?.get(messageId)
    if (!b || !m) return []
    return [...b.values()].filter((x) => x.parent_id === m.parent_id).sort((a, c) => a.seq - c.seq)
  }

  function isStreaming(sessionId: number): boolean {
    return pathFor(sessionId).some((m) => streamingIds.has(m.id))
  }

  async function loadSessions(): Promise<void> {
    for (const s of await api.sessions()) sessions.set(s.id, s)
  }

  async function loadMessages(sessionId: number): Promise<void> {
    ingestMessages(sessionId, await api.messages(sessionId))
  }

  function connect(): void {
    if (client.value) return
    client.value = new WsClient('/ws', {
      onEvent: applyEvent,
      onStatus: (s) => { status.value = s },
    })
    client.value.connect()
  }

  function send(cmd: WsCommand): void {
    client.value?.send(cmd)
  }

  return {
    status, sessions, messages, streamingIds, settings, lastError, sessionList,
    applyEvent, ingestMessages, pathFor, siblingsOf, isStreaming, loadSessions, loadMessages, connect, send,
  }
})
```

`src/client/stores/config.ts`:
```ts
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import type { Model, Provider } from '@/shared/models'

export const useConfigStore = defineStore('config', () => {
  const providers = ref<Provider[]>([])
  const modelsByProvider = ref<Record<number, Model[]>>({})
  const loaded = ref(false)

  async function load(): Promise<void> {
    providers.value = await api.providers()
    const entries = await Promise.all(providers.value.map(async (p) => [p.id, await api.models(p.id)] as const))
    modelsByProvider.value = Object.fromEntries(entries)
    loaded.value = true
  }

  function enabledModels(): Array<{ provider: Provider; model: Model }> {
    return providers.value.filter((p) => p.enabled).flatMap((provider) =>
      (modelsByProvider.value[provider.id] ?? []).filter((m) => m.enabled).map((model) => ({ provider, model })))
  }

  return { providers, modelsByProvider, loaded, load, enabledModels }
})
```

`src/client/router.ts`:
```ts
import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/chat.vue') },
    { path: '/c/:sessionId', component: () => import('./views/chat.vue'), props: true },
    { path: '/settings/providers', component: () => import('./views/settings-providers.vue') },
    { path: '/settings/providers/:id', component: () => import('./views/settings-provider-edit.vue'), props: true },
    { path: '/settings/plugins', component: () => import('./views/settings-plugins.vue') },
  ],
})
```

`src/client/main.ts`:
```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { enableKatex } from 'markstream-vue'
import './style.css'
import './styles/main.scss'
import 'katex/dist/katex.min.css'
import App from './app.vue'
import { router } from './router'

enableKatex(() => import('katex'))

createApp(App).use(createPinia()).use(router).mount('#app')
```

`src/client/app.vue`:
```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import AppShell from '@/client/components/app-shell.vue'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'

const sync = useSyncStore()
const config = useConfigStore()

onMounted(async () => {
  sync.connect()
  await Promise.all([sync.loadSessions(), config.load()])
})
</script>

<template lang="pug">
AppShell
  RouterView
</template>
```

`src/client/components/app-shell.vue`:
```vue
<script setup lang="ts">
import { ref } from 'vue'
import { Menu } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Sheet, SheetContent } from '@/client/ui/sheet'
import SessionList from '@/client/components/session-list.vue'
import { useSyncStore } from '@/client/stores/sync'

const sync = useSyncStore()
const drawerOpen = ref(false)
</script>

<template lang="pug">
.flex.h-dvh.w-full.overflow-hidden.bg-background.text-foreground
  aside.hidden.w-72.shrink-0.border-r.flex-col(class="md:flex")
    SessionList
  Sheet(v-model:open="drawerOpen")
    SheetContent(side="left" class="w-72 p-0")
      SessionList(@navigate="drawerOpen = false")
  .flex.min-w-0.flex-1.flex-col
    header.flex.h-12.items-center.gap-2.border-b.px-3
      Button(variant="ghost" size="icon" class="md:hidden" @click="drawerOpen = true")
        Menu(class="size-5")
      span.text-sm.font-medium only-chat
      span.ml-auto.size-2.rounded-full(:class="sync.status === 'open' ? 'bg-emerald-500' : 'bg-zinc-400'" :title="sync.status")
    .min-h-0.flex-1
      slot
</template>
```

Placeholder views (Task 14/15 replace them): `views/chat.vue`, `views/settings-providers.vue`, `views/settings-provider-edit.vue`, `views/settings-plugins.vue` each:
```vue
<script setup lang="ts"></script>
<template lang="pug">
.p-4 placeholder
</template>
```
and `components/session-list.vue`:
```vue
<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useSyncStore } from '@/client/stores/sync'
const emit = defineEmits<{ navigate: [] }>()
const sync = useSyncStore()
</script>
<template lang="pug">
.flex.h-full.flex-col
  .flex.items-center.justify-between.p-3
    RouterLink.text-sm.font-semibold(to="/" @click="emit('navigate')") 新对话
    RouterLink.text-xs.text-muted-foreground(to="/settings/providers" @click="emit('navigate')") 设置
  .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-2.pb-2
    RouterLink.block.truncate.rounded-md.px-2.py-1.text-sm(
      v-for="s in sync.sessionList" :key="s.id" :to="`/c/${s.id}`"
      class="hover:bg-accent" active-class="bg-accent" @click="emit('navigate')") {{ s.title }}
</template>
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run test/unit/client-ws-client.test.ts test/unit/client-sync-store.test.ts`
Expected: PASS (5 tests).

Run: `pnpm typecheck && pnpm build`
Expected: exit 0; `dist/client` and `dist/only_chat` produced. Fix any pug class issues (no `:`/`[`/`.`/`/` inside `.shorthand`; use `class="..."`).

Run `pnpm dev`, open `http://localhost:5173/`: the shell renders, the status dot turns green (WS connected), settings link navigates. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(client): tailwind/shadcn foundation, router, api client, websocket client and sync store"
```

---

### Task 14: Chat view — messages, markdown streaming, composer with images, branches

**Files:**
- Create: `src/client/lib/image-prep.ts`, `src/client/components/message-list.vue`, `src/client/components/message-item.vue`, `src/client/components/branch-switcher.vue`, `src/client/components/composer.vue`, `src/client/components/model-picker.vue`
- Modify: `src/client/views/chat.vue`
- Test: `test/unit/client-image-prep.test.ts` (hash + filename helpers only; canvas is browser-only)

**Interfaces:**
- Consumes: `useSyncStore`, `useConfigStore`, `api`, `MAX_IMAGE_EDGE`.
- Produces: `prepareImage(file: File | Blob): Promise<{ blob: Blob; width: number; height: number; sha256: string }>`, `sha256Hex(data: ArrayBuffer): Promise<string>`, `uploadImage(file): Promise<{ attachment_id: number }>` (check → upload); `useModelSelection()` state lives in `chat.vue` (`selected: ModelRef | null`, remembered in `localStorage` key `oc.model`).

- [ ] **Step 1: Write the failing test**

`test/unit/client-image-prep.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@/client/lib/image-prep'

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex', async () => {
    expect(await sha256Hex(new Uint8Array([1, 2, 3, 4]).buffer)).toBe('9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/client-image-prep.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement image-prep.ts**

```ts
import { api } from '@/client/lib/api'
import { MAX_IMAGE_EDGE } from '@/shared/constants'

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface PreparedImage {
  blob: Blob
  width: number
  height: number
  sha256: string
}

/** Downscales to MAX_IMAGE_EDGE on the longest side, re-encodes, and hashes. Browser only. */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  let blob: Blob = file
  if (scale < 1 || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    const type = file.type === 'image/png' ? 'image/png' : 'image/webp'
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, 0.9))
  }
  bitmap.close()
  return { blob, width, height, sha256: await sha256Hex(await blob.arrayBuffer()) }
}

export async function uploadImage(file: Blob): Promise<{ attachment_id: number; preview: string }> {
  const prepared = await prepareImage(file)
  const check = await api.checkAttachment(prepared.sha256)
  const attachment_id = check.exists && check.attachment_id !== undefined
    ? check.attachment_id
    : (await api.uploadAttachment(prepared.sha256, prepared.blob, prepared.width, prepared.height)).attachment_id
  return { attachment_id, preview: URL.createObjectURL(prepared.blob) }
}
```

- [ ] **Step 4: Components**

`src/client/components/model-picker.vue`:
```vue
<script setup lang="ts">
import { computed } from 'vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { useConfigStore } from '@/client/stores/config'
import type { ModelRef } from '@/shared/api'

const props = defineProps<{ modelValue: ModelRef | null }>()
const emit = defineEmits<{ 'update:modelValue': [ModelRef | null] }>()
const config = useConfigStore()

const options = computed(() => config.enabledModels().map(({ provider, model }) => ({
  key: `${provider.id}:${model.model_id}`, label: `${provider.name} · ${model.display_name}`, ref: { provider_id: provider.id, model_id: model.model_id },
})))
const current = computed(() => props.modelValue ? `${props.modelValue.provider_id}:${props.modelValue.model_id}` : '')

function onChange(key: string | null) {
  emit('update:modelValue', options.value.find((o) => o.key === key)?.ref ?? null)
}
</script>

<template lang="pug">
Select(:model-value="current" @update:model-value="onChange")
  SelectTrigger(class="h-8 w-56 text-xs")
    SelectValue(placeholder="选择模型")
  SelectContent
    SelectItem(v-for="o in options" :key="o.key" :value="o.key") {{ o.label }}
</template>
```

`src/client/components/branch-switcher.vue`:
```vue
<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { useSyncStore } from '@/client/stores/sync'
import type { Message } from '@/shared/models'

const props = defineProps<{ message: Message }>()
const sync = useSyncStore()
const siblings = computed(() => sync.siblingsOf(props.message.session_id, props.message.id))
const index = computed(() => siblings.value.findIndex((m) => m.id === props.message.id))

function go(delta: number) {
  const target = siblings.value[index.value + delta]
  if (target) sync.send({ type: 'switch_head', session_id: props.message.session_id, message_id: leafOf(target) })
}

/** Switching to a sibling shows that sibling's deepest descendant along first children. */
function leafOf(m: Message): number {
  const b = sync.messages.get(m.session_id)
  let cur = m
  while (b) {
    const child = [...b.values()].filter((x) => x.parent_id === cur.id).sort((a, c) => c.seq - a.seq)[0]
    if (!child) break
    cur = child
  }
  return cur.id
}
</script>

<template lang="pug">
.inline-flex.items-center.gap-1.text-xs.text-muted-foreground(v-if="siblings.length > 1")
  button.rounded(class="hover:bg-accent disabled:opacity-40" :disabled="index <= 0" @click="go(-1)")
    ChevronLeft(class="size-4")
  span {{ index + 1 }} / {{ siblings.length }}
  button.rounded(class="hover:bg-accent disabled:opacity-40" :disabled="index >= siblings.length - 1" @click="go(1)")
    ChevronRight(class="size-4")
</template>
```

`src/client/components/message-item.vue`:
```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownRender from 'markstream-vue'
import { RefreshCw, Pencil } from '@lucide/vue'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Textarea } from '@/client/ui/textarea'
import BranchSwitcher from '@/client/components/branch-switcher.vue'
import { useSyncStore } from '@/client/stores/sync'
import type { Message } from '@/shared/models'

const props = defineProps<{ message: Message }>()
const sync = useSyncStore()
const streaming = computed(() => props.message.status === 'streaming')
const editing = ref(false)
const draft = ref('')

const textParts = computed(() => props.message.parts.filter((p) => p.type === 'text'))
const reasoning = computed(() => props.message.parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join('\n'))
const images = computed(() => props.message.parts.filter((p) => p.type === 'image'))

function startEdit() {
  draft.value = textParts.value.map((p) => p.text).join('\n')
  editing.value = true
}
function submitEdit() {
  const parts = [...images.value, { type: 'text' as const, text: draft.value }]
  sync.send({ type: 'edit', message_id: props.message.id, parts })
  editing.value = false
}
function regenerate() {
  sync.send({ type: 'regenerate', message_id: props.message.id })
}
</script>

<template lang="pug">
.group.flex.flex-col.gap-1(:class="message.role === 'user' ? 'items-end' : 'items-start'")
  .max-w-full(:class="message.role === 'user' ? 'oc-message-user bg-primary text-primary-foreground px-3 py-2' : 'w-full'")
    template(v-if="message.role === 'user'")
      .flex.flex-wrap.gap-2.pb-1(v-if="images.length")
        img.max-h-40.rounded(v-for="img in images" :key="img.attachment_id" :src="api.attachmentUrl(img.attachment_id)")
      template(v-if="!editing")
        p.whitespace-pre-wrap.text-sm(v-for="(p, i) in textParts" :key="i") {{ p.text }}
      .flex.flex-col.gap-2(v-else)
        Textarea(v-model="draft" class="min-w-64 bg-background text-foreground")
        .flex.gap-2.justify-end
          Button(size="sm" variant="secondary" @click="editing = false") 取消
          Button(size="sm" @click="submitEdit") 发送
    template(v-else)
      details.mb-2.rounded.border.px-2.py-1.text-xs.text-muted-foreground(v-if="reasoning")
        summary 思考过程
        pre.whitespace-pre-wrap.pt-1 {{ reasoning }}
      MarkdownRender(mode="chat" :content="textParts.map(p => p.text).join('')" :final="!streaming" smooth-streaming="auto" :fade="false")
      p.text-xs.text-destructive(v-if="message.status === 'error'") 出错：{{ message.error }}
      p.text-xs.text-muted-foreground(v-else-if="message.status === 'aborted'") 已停止
  .flex.items-center.gap-2.text-xs.text-muted-foreground.opacity-0(class="group-hover:opacity-100 focus-within:opacity-100")
    BranchSwitcher(:message="message")
    button.inline-flex.items-center.gap-1(v-if="message.role === 'assistant' && !streaming" @click="regenerate")
      RefreshCw(class="size-3")
      span 重新生成
    button.inline-flex.items-center.gap-1(v-if="message.role === 'user' && !editing" @click="startEdit")
      Pencil(class="size-3")
      span 编辑
    span(v-if="message.usage") {{ message.usage.prompt ?? '?' }} / {{ message.usage.completion ?? '?' }} tokens
</template>
```

`src/client/components/message-list.vue`:
```vue
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import MessageItem from '@/client/components/message-item.vue'
import type { Message } from '@/shared/models'

const props = defineProps<{ messages: Message[] }>()
const el = ref<HTMLElement | null>(null)
const stick = ref(true)

function onScroll() {
  const e = el.value
  if (!e) return
  stick.value = e.scrollHeight - e.scrollTop - e.clientHeight < 48
}

watch(() => props.messages.map((m) => m.parts.map((p) => ('text' in p ? p.text.length : 0)).join(',')).join('|'), async () => {
  if (!stick.value) return
  await nextTick()
  el.value?.scrollTo({ top: el.value.scrollHeight })
})
</script>

<template lang="pug">
.oc-scroll.h-full.overflow-y-auto.px-4.py-4(ref="el" @scroll="onScroll")
  .mx-auto.flex.max-w-3xl.flex-col.gap-4
    MessageItem(v-for="m in messages" :key="m.id" :message="m")
</template>
```

`src/client/components/composer.vue`:
```vue
<script setup lang="ts">
import { ref } from 'vue'
import { ImagePlus, Send, Square, X } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Textarea } from '@/client/ui/textarea'
import ModelPicker from '@/client/components/model-picker.vue'
import { uploadImage } from '@/client/lib/image-prep'
import type { ModelRef } from '@/shared/api'
import type { Part } from '@/shared/parts'

const props = defineProps<{ streaming: boolean; connected: boolean; model: ModelRef | null }>()
const emit = defineEmits<{ send: [parts: Part[]]; stop: []; 'update:model': [ModelRef | null] }>()

const text = ref('')
const images = ref<Array<{ attachment_id: number; preview: string; failed?: boolean }>>([])
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function addFiles(files: Iterable<File>) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    busy.value = true
    try { images.value.push(await uploadImage(f)) }
    catch (err) { console.error(err); images.value.push({ attachment_id: -1, preview: '', failed: true }) }
    finally { busy.value = false }
  }
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) { e.preventDefault(); void addFiles(files) }
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  void addFiles(e.dataTransfer?.files ?? [])
}
function submit() {
  const parts: Part[] = images.value.filter((i) => !i.failed).map((i) => ({ type: 'image', attachment_id: i.attachment_id }))
  if (text.value.trim()) parts.push({ type: 'text', text: text.value })
  if (!parts.length || !props.model || !props.connected) return
  emit('send', parts)
  text.value = ''
  images.value = []
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
}
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  void addFiles(input.files ?? [])
  input.value = ''
}
</script>

<template lang="pug">
.border-t.p-3(@drop="onDrop" @dragover.prevent)
  .mx-auto.flex.max-w-3xl.flex-col.gap-2
    .flex.flex-wrap.gap-2(v-if="images.length")
      .relative(v-for="(img, i) in images" :key="i")
        img.h-16.w-16.rounded.object-cover(v-if="!img.failed" :src="img.preview")
        .h-16.w-16.rounded.bg-destructive.text-xs.text-white.flex.items-center.justify-center(v-else) 失败
        button.absolute.-right-1.-top-1.rounded-full.bg-background.border(@click="images.splice(i, 1)")
          X(class="size-3")
    Textarea(v-model="text" rows="3" placeholder="输入消息，Enter 发送，Shift+Enter 换行，可粘贴图片" @keydown="onKeydown" @paste="onPaste")
    .flex.items-center.gap-2
      ModelPicker(:model-value="model" @update:model-value="emit('update:model', $event)")
      input.hidden(ref="fileInput" type="file" accept="image/*" multiple @change="onFileChange")
      Button(variant="ghost" size="icon" :disabled="busy" @click="fileInput?.click()")
        ImagePlus(class="size-4")
      span.ml-auto.text-xs.text-muted-foreground(v-if="!connected") 未连接
      Button(v-if="streaming" size="sm" variant="destructive" @click="emit('stop')")
        Square(class="size-4")
        span 停止
      Button(v-else size="sm" :disabled="!connected || !model || busy" @click="submit")
        Send(class="size-4")
        span 发送
</template>
```
Note: never put TypeScript syntax (`as`, `!`, generics) inside template expressions — Vue compiles them as JavaScript. Casts live in script functions such as `onFileChange`, per the `pug-vue-pitfalls` skill.

`src/client/views/chat.vue`:
```vue
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import MessageList from '@/client/components/message-list.vue'
import Composer from '@/client/components/composer.vue'
import { Input } from '@/client/ui/input'
import { Textarea } from '@/client/ui/textarea'
import { useSyncStore } from '@/client/stores/sync'
import type { ModelRef } from '@/shared/api'
import type { Part } from '@/shared/parts'

const props = defineProps<{ sessionId?: string }>()
const router = useRouter()
const sync = useSyncStore()

const sid = computed(() => (props.sessionId ? Number(props.sessionId) : null))
const session = computed(() => (sid.value === null ? undefined : sync.sessions.get(sid.value)))
const path = computed(() => (sid.value === null ? [] : sync.pathFor(sid.value)))
const streaming = computed(() => sid.value !== null && sync.isStreaming(sid.value))

const model = ref<ModelRef | null>(readModel())
watch(model, (m) => localStorage.setItem('oc.model', JSON.stringify(m)))
watch(session, (s) => { if (s?.provider_id && s.model_id) model.value = { provider_id: s.provider_id, model_id: s.model_id } }, { immediate: true })

watch(sid, (id) => { if (id !== null) void sync.loadMessages(id) }, { immediate: true })
watch(() => sync.status, (s) => { if (s === 'open' && sid.value !== null) void sync.loadMessages(sid.value) })

// A `send` on a fresh page creates the session server-side; jump to it when it appears.
const pendingNew = ref(false)
watch(() => sync.sessionList[0]?.id, (newest) => {
  if (pendingNew.value && newest !== undefined && sid.value === null) { pendingNew.value = false; void router.push(`/c/${newest}`) }
})

function readModel(): ModelRef | null {
  try { return JSON.parse(localStorage.getItem('oc.model') ?? 'null') as ModelRef | null } catch { return null }
}

function onSend(parts: Part[]) {
  if (!model.value) return
  if (sid.value === null) pendingNew.value = true
  sync.send({ type: 'send', session_id: sid.value, parent_id: session.value?.head_message_id ?? null, parts, ...model.value })
}
function onStop() {
  if (sid.value !== null) sync.send({ type: 'stop', session_id: sid.value })
}
function updateTitle(e: Event) {
  const title = (e.target as HTMLInputElement).value.trim()
  if (sid.value !== null && title) sync.send({ type: 'session.update', session_id: sid.value, title })
}
function updateSystemPrompt(e: Event) {
  const v = (e.target as HTMLTextAreaElement).value
  if (sid.value !== null) sync.send({ type: 'session.update', session_id: sid.value, system_prompt: v || null })
}
</script>

<template lang="pug">
.flex.h-full.flex-col
  .flex.items-center.gap-2.border-b.px-4.py-2(v-if="session")
    Input(:model-value="session.title" class="h-8 max-w-xs text-sm" @change="updateTitle")
    details.text-xs
      summary.cursor-pointer.text-muted-foreground 系统提示
      Textarea(:model-value="session.system_prompt ?? ''" rows="3" class="mt-2 w-80" placeholder="留空则不发送 system prompt" @change="updateSystemPrompt")
  .min-h-0.flex-1
    MessageList(:messages="path")
    .flex.h-full.items-center.justify-center.text-muted-foreground(v-if="!path.length") 开始一段新对话
  Composer(:streaming="streaming" :connected="sync.status === 'open'" v-model:model="model" @send="onSend" @stop="onStop")
</template>
```
Move the two `as` casts in the template handlers into script functions if any remain; the ones above already live in `<script>`.

- [ ] **Step 5: Run tests, typecheck, manual check**

Run: `pnpm vitest run test/unit/client-image-prep.test.ts && pnpm typecheck && pnpm build`
Expected: all green.

Manual (`pnpm dev`, browser at `http://localhost:5173`): with no providers the model picker is empty and send is disabled. Add a provider in Task 15, then come back: send a message, watch it stream; open a second tab and confirm the same stream appears; paste an image and send to a vision model; edit a user message and use the branch switcher; press stop mid-stream.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(client): chat view with streaming markdown, image composer and branch switching"
```

---

### Task 15: Settings — providers, models, presets, plugins page

**Files:**
- Modify: `src/client/views/settings-providers.vue`, `src/client/views/settings-provider-edit.vue`, `src/client/views/settings-plugins.vue`

**Interfaces:** consumes `api`, `useConfigStore`, `useSyncStore.settings`, `PRESET_PROVIDERS` via `/api/presets`.

- [ ] **Step 1: Providers list with preset picker**

`src/client/views/settings-providers.vue`:
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { useConfigStore } from '@/client/stores/config'
import type { PresetProvider } from '@/server/plugins/llm/presets'

const config = useConfigStore()
const router = useRouter()
const presets = ref<PresetProvider[]>([])
const chosen = ref<string>('')

onMounted(async () => { presets.value = await api.presets(); await config.load() })

async function addFromPreset() {
  const preset = presets.value.find((p) => p.key === chosen.value)
  const created = preset
    ? await api.createProvider({ name: preset.name, protocol: preset.protocol, base_url: preset.base_url })
    : await api.createProvider({ name: '自定义供应商', protocol: 'openai-completions', base_url: 'https://api.example.com/v1' })
  if (preset) for (const m of preset.models) await api.createModel(created.id, { model_id: m.model_id, display_name: m.display_name, capabilities: m.capabilities })
  await config.load()
  await router.push(`/settings/providers/${created.id}`)
}
</script>

<template lang="pug">
.mx-auto.max-w-2xl.p-4.flex.flex-col.gap-4
  h1.text-lg.font-semibold 供应商
  .flex.gap-2
    Select(v-model="chosen")
      SelectTrigger(class="w-56")
        SelectValue(placeholder="从预制模板添加…")
      SelectContent
        SelectItem(v-for="p in presets" :key="p.key" :value="p.key") {{ p.name }}
    Button(@click="addFromPreset") 添加
  ul.divide-y.rounded-md.border
    li.flex.items-center.gap-3.p-3(v-for="p in config.providers" :key="p.id")
      RouterLink.font-medium(:to="`/settings/providers/${p.id}`") {{ p.name }}
      span.text-xs.text-muted-foreground {{ p.protocol }}
      span.ml-auto.text-xs(:class="p.enabled ? 'text-emerald-600' : 'text-muted-foreground'") {{ p.enabled ? '启用' : '停用' }}
      span.text-xs.text-muted-foreground {{ p.has_key ? '已配置密钥' : '无密钥' }}
  RouterLink.text-sm.text-muted-foreground(to="/settings/plugins") 插件开关 →
</template>
```

- [ ] **Step 2: Provider edit with models**

`src/client/views/settings-provider-edit.vue`:
```vue
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'
import { Label } from '@/client/ui/label'
import { Switch } from '@/client/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { useConfigStore } from '@/client/stores/config'
import type { Model, Protocol } from '@/shared/models'

const props = defineProps<{ id: string }>()
const router = useRouter()
const config = useConfigStore()
const pid = computed(() => Number(props.id))

const form = reactive({ name: '', protocol: 'openai-completions' as Protocol, base_url: '', api_key: '', enabled: true, project: '', location: '' })
const models = ref<Model[]>([])
const newModelId = ref('')
const status = ref('')

onMounted(async () => {
  if (!config.loaded) await config.load()
  const p = config.providers.find((x) => x.id === pid.value)
  if (!p) { await router.push('/settings/providers'); return }
  Object.assign(form, { name: p.name, protocol: p.protocol, base_url: p.base_url, enabled: p.enabled, project: String(p.extra?.project ?? ''), location: String(p.extra?.location ?? '') })
  models.value = await api.models(pid.value)
})

async function save() {
  const extra = form.protocol === 'vertex' ? { project: form.project, location: form.location } : null
  await api.updateProvider(pid.value, { name: form.name, protocol: form.protocol, base_url: form.base_url, enabled: form.enabled, extra, ...(form.api_key ? { api_key: form.api_key } : {}) })
  form.api_key = ''
  status.value = '已保存'
  await config.load()
}
async function remove() {
  await api.deleteProvider(pid.value)
  await config.load()
  await router.push('/settings/providers')
}
async function fetchModels() {
  status.value = '拉取中…'
  try { const r = await api.fetchModels(pid.value); status.value = `导入 ${r.imported} 个新模型`; models.value = await api.models(pid.value) }
  catch (err) { status.value = String(err) }
}
async function addModel() {
  if (!newModelId.value.trim()) return
  await api.createModel(pid.value, { model_id: newModelId.value.trim() })
  newModelId.value = ''
  models.value = await api.models(pid.value)
  await config.load()
}
async function toggleModel(m: Model, key: 'enabled' | 'vision' | 'reasoning' | 'tools', value: boolean) {
  const patch = key === 'enabled' ? { enabled: value } : { capabilities: { ...m.capabilities, [key]: value } }
  await api.updateModel(pid.value, m.id, patch)
  models.value = await api.models(pid.value)
  await config.load()
}
async function removeModel(m: Model) {
  await api.deleteModel(pid.value, m.id)
  models.value = await api.models(pid.value)
  await config.load()
}
</script>

<template lang="pug">
.mx-auto.max-w-2xl.p-4.flex.flex-col.gap-4
  h1.text-lg.font-semibold 编辑供应商
  .grid.gap-3
    div
      Label 名称
      Input(v-model="form.name")
    div
      Label 协议
      Select(v-model="form.protocol")
        SelectTrigger
          SelectValue
        SelectContent
          SelectItem(value="openai-completions") OpenAI Chat Completions（含各类兼容中转）
          SelectItem(value="openai-responses") OpenAI Responses
          SelectItem(value="anthropic") Anthropic Messages
          SelectItem(value="vertex") Google Vertex AI
    div
      Label Base URL
      Input(v-model="form.base_url" placeholder="https://api.example.com/v1")
    div
      Label {{ form.protocol === 'vertex' ? '服务账号 JSON（留空保持不变）' : 'API Key（留空保持不变）' }}
      Input(v-model="form.api_key" type="password" autocomplete="off")
    template(v-if="form.protocol === 'vertex'")
      div
        Label Project
        Input(v-model="form.project")
      div
        Label Location
        Input(v-model="form.location" placeholder="us-central1 / global")
    .flex.items-center.gap-2
      Switch(:model-value="form.enabled" @update:model-value="form.enabled = $event")
      Label 启用
  .flex.gap-2
    Button(@click="save") 保存
    Button(variant="secondary" @click="fetchModels" :disabled="form.protocol === 'vertex'") 从 /models 拉取
    Button(variant="destructive" class="ml-auto" @click="remove") 删除供应商
  p.text-xs.text-muted-foreground(v-if="status") {{ status }}
  h2.font-medium 模型
  .flex.gap-2
    Input(v-model="newModelId" placeholder="model id，例如 gpt-5.1" @keydown.enter="addModel")
    Button(@click="addModel") 添加
  table.w-full.text-sm
    thead
      tr.text-left.text-xs.text-muted-foreground
        th.py-1 模型
        th 启用
        th 视觉
        th 推理
        th 工具
        th
    tbody
      tr.border-t(v-for="m in models" :key="m.id")
        td.py-1 {{ m.display_name }}
          span.ml-1.text-xs.text-muted-foreground(v-if="m.display_name !== m.model_id") {{ m.model_id }}
        td
          Switch(:model-value="m.enabled" @update:model-value="toggleModel(m, 'enabled', $event)")
        td
          Switch(:model-value="!!m.capabilities.vision" @update:model-value="toggleModel(m, 'vision', $event)")
        td
          Switch(:model-value="!!m.capabilities.reasoning" @update:model-value="toggleModel(m, 'reasoning', $event)")
        td
          Switch(:model-value="!!m.capabilities.tools" @update:model-value="toggleModel(m, 'tools', $event)")
        td.text-right
          button.text-xs.text-destructive(@click="removeModel(m)") 删除
</template>
```

- [ ] **Step 3: Plugins page (mechanism only)**

`src/client/views/settings-plugins.vue`:
```vue
<script setup lang="ts">
import { Switch } from '@/client/ui/switch'
import { useSyncStore } from '@/client/stores/sync'

/** MVP ships no feature plugins; the list is driven by whatever keys exist in settings.plugins. */
const sync = useSyncStore()
function toggle(key: string, value: boolean) {
  sync.send({ type: 'settings.update', settings: { plugins: { [key]: value } } })
}
</script>

<template lang="pug">
.mx-auto.max-w-2xl.p-4.flex.flex-col.gap-4
  h1.text-lg.font-semibold 插件
  p.text-sm.text-muted-foreground 功能插件会出现在这里，可以随时开关。当前版本尚未内置任何功能插件。
  ul.divide-y.rounded-md.border(v-if="Object.keys(sync.settings.plugins).length")
    li.flex.items-center.gap-3.p-3(v-for="(on, key) in sync.settings.plugins" :key="key")
      span {{ key }}
      Switch(class="ml-auto" :model-value="on" @update:model-value="toggle(String(key), $event)")
</template>
```

The client must know its settings on load: in `src/client/app.vue` `onMounted`, add `sync.settings = (await api.me()).settings` (import `api`).

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm build`
Expected: green.

Manual: add "Anthropic" from presets, paste a real key, save, enable a model; go to `/`, pick the model, send "hello" and watch the stream. Then add an OpenAI-compatible provider (DeepSeek) and repeat; confirm `deepseek-reasoner` shows a 思考过程 block. Vertex and OpenAI Responses are exercised in Task 16.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(client): provider, model and plugin settings pages"
```

---

### Task 16: Acceptance run, README, full test pass

**Files:**
- Create: `README.md`
- Modify: none expected; fix whatever the acceptance run reveals (each fix its own commit).

- [ ] **Step 1: Full test suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: all projects pass. This is the one place the full suite runs.

- [ ] **Step 2: Manual acceptance (one pass per protocol)**

With `pnpm dev` running and real keys in the providers page:
1. `openai-responses`: send, stream, regenerate; a second turn must reuse the same session and show reasoning if `reasoning_effort` is set via session params (edit `params` through `session.update` from the browser console: `useSyncStore().send({ type: 'session.update', session_id: N, params: { reasoning_effort: 'low' } })`).
2. `anthropic`: send two turns; open the browser devtools network tab is not enough to see cache hits, so check the stored `usage.cached` on the second assistant message (`GET /api/sessions/:id/messages`) is > 0.
3. `openai-completions` (DeepSeek or a relay): `deepseek-reasoner` shows a reasoning block; the second turn does not error (reasoning is stripped on replay).
4. `vertex`: paste the service-account JSON into the key field, set project/location, send once.
5. Multi-device: open the same session in a second browser (or phone on the LAN via `vite dev --host`); both see the same stream; close the sender tab mid-stream, the other tab still finishes.
6. Image: paste an image to a vision model and ask what it shows.
7. Stop, edit, branch switch, delete session, rename session.

Record any failure as a bug, fix with a focused commit, re-run the relevant test.

- [ ] **Step 3: README**

`README.md`:
```markdown
# only-chat

Personal AI chat on Cloudflare Workers. Every device sees the same sessions and live streams.

## Dev

    cp .dev.vars.example .dev.vars   # set KEY_ENCRYPTION_SECRET
    pnpm install
    pnpm db:migrate:local
    pnpm dev                          # http://localhost:5173

## Deploy (first time)

    wrangler d1 create only-chat-db   # paste database_id into wrangler.jsonc
    wrangler r2 bucket create only-chat-attachments
    wrangler secret put KEY_ENCRYPTION_SECRET
    pnpm db:migrate:remote
    pnpm deploy

There is no authentication yet: put Cloudflare Access in front of the domain before exposing it.

## Layout

See `docs/superpowers/specs/2026-09-05-only-chat-mvp-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README with dev and deploy steps"
```

---

## Self-review notes (done while writing)

- Spec coverage: §2 scope → Tasks 1–15; §4.4 cordis usage → Tasks 5, 8, 10 (`inject`, `Service.init`, `ctx.effect`, settings-driven plugin toggle mechanism in `settingsUpdate`); §6 data model → Task 4; §7 LLM + invariant → Tasks 6–8; §8 WS + DO lifecycle → Tasks 10–11 (awaited generation, inflight storage, alarm, recovery); §9 REST → Task 12; §10 frontend → Tasks 13–15; §11 errors → Tasks 11, 13, 14; §12 tests → every task; §13 versions → Task 1.
- Known simplification vs spec: `message.part` is not emitted for reasoning `providerOptions` updates (clients do not need them); the DB row is authoritative and REST reload restores full parts.
- Deferred by design (not gaps): Vertex OAuth token caching; feature plugins themselves; auth.
