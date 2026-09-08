# User Authentication and Conversation Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Better Auth multi-user authentication, strict per-user data isolation, minimal account administration, and replace the chat-domain `Session` concept with `Conversation` everywhere.

**Architecture:** Better Auth 1.7.3 owns credentials, AuthSessions, cookies, security checks, rate limiting, and account administration on the Worker side. A thin Hono boundary resolves `authSession` and passes a validated integer user ID into every REST route and the user's Durable Object; each UserHub remains the sole realtime writer for one user. D1 remains authoritative, while the existing chat schema and protocol are migrated atomically from Session naming to Conversation naming.

**Tech Stack:** TypeScript 6, Vue 3, Pinia 4, Hono 4, Cordis 4, Better Auth 1.7.3, Better Auth Drizzle adapter 1.7.3, Drizzle ORM 0.45, Cloudflare Workers, D1, Durable Objects, Vitest 4, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-08-user-auth-and-conversation-naming-design.md`

## Global Constraints

- Before Task 1, run `git rebase main` in this worktree and `pnpm test`; other agents are currently finishing work that must land first.
- Use Better Auth's `user` / `admin` roles; configure user ID `"1"` as an unconditional administrator.
- Use `authSession`, `authUser`, `AuthSession`, `AuthUser`, and `auth_sessions` for authentication. Never use a bare `session` variable for login state.
- Rename the chat concept completely to `Conversation`, including the physical D1 table and `messages.conversation_id`.
- D1 is authoritative for users, credentials, AuthSessions, bans, and registration settings.
- `ALLOW_REGISTER` resolution is D1 override, then environment value, then `false`; registration never changes the setting automatically.
- Closing registration blocks public user creation from every identity provider but does not block existing identities or administrator-created users.
- All business resources are owner-scoped. Cross-user access returns `404`; unauthenticated access returns `401`; insufficient account-management permission returns `403`.
- The administration surface must not expose other users' Conversations, Projects, Providers, models, attachments, or settings.
- Do not add user deletion, email delivery, email verification, self-service password recovery, OAuth, or Passkeys.
- Passwords, cookies, AuthSession tokens, OAuth tokens, and Provider API keys must never appear in logs or command arguments.
- Comments added or changed in source code must be in English.
- Each commit message must be English Conventional Commits.

---

### Task 1: Rename the chat domain from Session to Conversation

**Files:**

- Create: `migrations/0007_conversations.sql`
- Rename: `src/server/plugins/api/sessions.ts` → `src/server/plugins/api/conversations.ts`
- Rename: `src/server/plugins/hub/sessions.ts` → `src/server/plugins/hub/conversations.ts`
- Rename: `src/client/components/layout/session-nav-row.vue` → `src/client/components/layout/conversation-nav-row.vue`
- Rename: `src/client/components/session-settings.vue` → `src/client/components/conversation-settings.vue`
- Rename: `src/client/composables/use-session-fork.ts` → `src/client/composables/use-conversation-fork.ts`
- Rename: `src/client/lib/session-export.ts` → `src/client/lib/conversation-export.ts`
- Rename: `src/client/views/project-sessions.vue` → `src/client/views/project-conversations.vue`
- Rename: `test/worker/hub-sessions.test.ts` → `test/worker/hub-conversations.test.ts`
- Rename: `test/unit/client-session-export.test.ts` → `test/unit/client-conversation-export.test.ts`
- Rename: `test/unit/client-project-sessions.test.ts` → `test/unit/client-project-conversations.test.ts`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/cordis.d.ts`
- Modify: `src/server/plugins/api/index.ts`
- Modify: `src/server/plugins/hub/{index,generation,effective-config,projects,seq,attachment-transport}.ts`
- Modify: `src/server/plugins/llm/{messages,observability}.ts`
- Modify: `src/shared/{models,api,ws}.ts`
- Modify: `src/client/{app.vue,typed-router.d.ts}`
- Modify: `src/client/components/{branch-switcher,message-item,model-editor,reasoning-control}.vue`
- Modify: `src/client/components/layout/{app-sidebar,chat-sidebar-content}.vue`
- Modify: `src/client/lib/{api,model-editor,ui-models}.ts`
- Modify: `src/client/pages/{new.vue,index.vue}` and `src/client/pages/project/[projectId]/{index.vue,new.vue,settings.vue}`
- Modify: `src/client/stores/sync.ts`
- Modify: `src/client/views/{chat,chat-index,project-settings,projects-index}.vue`
- Modify: all tests containing chat-domain `Session`, `session_id`, `/api/sessions`, or `session.*`
- Test: `test/worker/conversation-migration.test.ts`

**Interfaces:**

- Produces: `Conversation`, `ConversationSchema`, `ConversationParams`, `ConversationRow`, `conversation_id`, `/api/conversations`, and `conversation.*` WebSocket/Cordis events.
- Produces: `conversationPath(conversation: Conversation): string`, `useConversationFork()`, and `conversationExport()` under the renamed modules.
- Removes: chat-domain `Session`, `SessionSchema`, `SessionParams`, `SessionRow`, `session_id`, `/api/sessions`, and `session.*` symbols.

- [ ] **Step 1: Add failing contract and migration tests**

Update the shared-model/protocol tests to import the new names and require the new wire fields. Add a migration test that creates the legacy tables, inserts a branching Conversation, applies the new migration, and checks data and foreign keys:

```ts
expect(ConversationSchema.parse(row)).toMatchObject({ id: 7, title: 'legacy' })
expect(MessageSchema.parse(message)).toMatchObject({ conversation_id: 7 })
expect(WsEventSchema.parse({
  type: 'conversation.updated',
  conversation: row,
})).toBeTruthy()

const tables = await migrated.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
).all<{ name: string }>()
expect(tables.results.map(row => row.name)).toContain('conversations')
expect(tables.results.map(row => row.name)).not.toContain('sessions')
```

- [ ] **Step 2: Run the focused tests and confirm the old contract fails**

Run:

```bash
pnpm vitest run --project unit test/unit/shared-models.test.ts test/unit/shared-ws.test.ts
pnpm vitest run --project worker test/worker/conversation-migration.test.ts
```

Expected: failures for missing `ConversationSchema`, `conversation_id`, and migration file.

- [ ] **Step 3: Add the physical D1 rename migration**

Create a coordinated migration that renames the table and message foreign-key column, then recreates indexes with Conversation names:

```sql
ALTER TABLE `sessions` RENAME TO `conversations`;
ALTER TABLE `messages` RENAME COLUMN `session_id` TO `conversation_id`;
DROP INDEX `sessions_user_updated_idx`;
DROP INDEX `sessions_project_updated_idx`;
DROP INDEX `messages_session_seq_uq`;
CREATE INDEX `conversations_user_updated_idx` ON `conversations` (`user_id`,`updated_at`);
CREATE INDEX `conversations_project_updated_idx` ON `conversations` (`project_id`,`updated_at`);
CREATE UNIQUE INDEX `messages_conversation_seq_uq` ON `messages` (`conversation_id`,`seq`);
```

After the pre-task rebase, if `0007` already exists, renumber this and every later migration together without changing their order.

- [ ] **Step 4: Rename server and shared contracts mechanically**

Use `git mv` for the files listed above. Rename schema exports, functions, variables, DTO fields, command/event types, Cordis events, error text, and comments. Representative target contracts:

```ts
export const ConversationSchema = z.object({
  id: z.number().int(),
  user_id: z.number().int(),
  project_id: z.number().int().nullable(),
  title: z.string(),
  head_message_id: z.number().int().nullable(),
  provider_id: z.number().int().nullable(),
  model_id: z.string().nullable(),
  system_prompt: z.string().nullable(),
  params: ConversationParamsSchema.nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  archived_at: z.number().nullable(),
})

export const MessageSchema = z.object({
  id: z.number().int(),
  conversation_id: z.number().int(),
  // unchanged message fields
})
```

WebSocket names become `conversation.update`, `conversation.delete`, `conversation.fork`, `conversation.created`, `conversation.updated`, `conversation.deleted`, and `conversation.forked`. Generic generation commands retain `send`, `edit`, `regenerate`, `stop`, and `switch_head`, but their identifier field becomes `conversation_id`.

- [ ] **Step 5: Rename the client contract and route parameter**

Rename Store collections and methods (`conversations`, `loadConversations`, `activeConversation`) and change `/new/:sessionId?` to `/new/:conversationId?`. Keep the existing short `/c/:conversationId?` URL. Update API calls:

```ts
export const api = {
  conversations: () => request<Conversation[]>('GET', '/api/conversations'),
  messages: (conversationId: number) =>
    request<Message[]>('GET', `/api/conversations/${conversationId}/messages`),
}
```

- [ ] **Step 6: Prove the old chat Session vocabulary is gone**

Run:

```bash
rg -n "Session|session_id|/api/sessions|session\." src test \
  -g '!src/client/ui/**' \
  -g '!docs/**'
```

Expected: only Better Auth-independent platform names that are not the chat domain, if any. Inspect each result; do not whitelist chat leftovers.

- [ ] **Step 7: Run all renamed tests and typechecks**

Run:

```bash
pnpm typecheck
pnpm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit the semantic rename**

```bash
git add migrations src test
git commit -m "refactor(chat): rename sessions to conversations"
```

---

### Task 2: Add the Better Auth schema and authentication service

**Files:**

- Create: `migrations/0008_user-auth.sql`
- Create: `src/server/plugins/auth/index.ts`
- Create: `src/server/plugins/auth/access.ts`
- Create: `src/server/plugins/auth/user-id.ts`
- Create: `src/shared/auth.ts`
- Create: `test/unit/auth-user-id.test.ts`
- Create: `test/worker/auth-schema.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/server/app.ts`
- Modify: `src/server/cordis.d.ts`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/plugins/database.ts`
- Modify: `test/env.d.ts`
- Modify: `vitest.config.ts`
- Modify: `wrangler.jsonc`
- Modify: `.dev.vars.example`

**Interfaces:**

- Produces: Cordis service `ctx.auth` exposing `instance` and Better Auth inferred types.
- Produces: `parseAuthUserId(value: string | number): number`, which accepts only positive safe integers.
- Produces: Drizzle exports `authAccounts`, `authSessions`, `authVerifications`, and `siteSettings`.
- Produces: shared `PublicSiteSettingsSchema`, `AuthUserSummarySchema`, and `AdminUserSummarySchema`.

- [ ] **Step 1: Add Better Auth 1.7.3 and write failing schema tests**

Install exact matching packages:

```bash
pnpm add better-auth@1.7.3 @better-auth/drizzle-adapter@1.7.3
```

Before configuring them, inspect the installed 1.7.3 exports and adapter types:

```bash
rg -n "generateId|modelName|adminUserIds|validateUserInfo" \
  node_modules/better-auth node_modules/@better-auth/drizzle-adapter \
  -g '*.d.ts' | head -120
```

Add tests proving there is no startup seed and that the auth tables use distinct names:

```ts
it('does not create a default user at startup', async () => {
  const app = await createApp({ env, side: 'worker' })
  expect(await app.db.orm.select().from(users)).toEqual([])
})

it('uses distinct authentication table names', () => {
  expect(getTableName(conversations)).toBe('conversations')
  expect(getTableName(authSessions)).toBe('auth_sessions')
})
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm vitest run --project unit test/unit/auth-user-id.test.ts
pnpm vitest run --project worker test/worker/auth-schema.test.ts
```

Expected: missing auth modules/tables and the current automatic `uid=1` seed causes failure.

- [ ] **Step 3: Extend `users` and add Better Auth tables**

Model the Better Auth fields with camelCase TypeScript properties mapped to snake_case D1 columns. Preserve `settings` as an application-owned JSON column:

```ts
export const users = sqliteTable('users', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  email: text().notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text(),
  role: text().notNull().default('user'),
  banned: integer({ mode: 'boolean' }).notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp_ms' }),
  settings: text({ mode: 'json' }).$type<UserSettings>().notNull().default({ plugins: {} }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
```

Define `authAccounts`, `authSessions`, and `authVerifications` exactly from Better Auth 1.7.3's generated Drizzle schema, changing only physical/model names and foreign-key ID types. Add Admin plugin fields to users and the plugin's AuthSession field to `authSessions`. Define `siteSettings` with `key`, nullable `value`, and `updatedAt` mapped to `updated_at`; Task 3 owns its policy logic.

- [ ] **Step 4: Write the coordinated auth migration**

Add the Better Auth columns with `ALTER TABLE` so D1 never drops the parent `users` table or activates cascading foreign keys. Give added required columns migration-safe defaults, then update every existing row to the unique unreachable placeholder email `legacy-user-{id}@invalid.local`, `email_verified = 0`, `role = 'user'`, `banned = 0`, and `updated_at = created_at` before creating the unique email index. Preserve IDs, names, settings, and all foreign-key references. Create the three auth tables, their Better Auth-required unique indexes, and the `site_settings` table.

No `auth_accounts` row is created for a legacy user, so placeholder emails cannot log in. Use `PRAGMA foreign_key_check` in the migration test and verify existing Providers, Projects, Conversations, and attachments still reference the same user ID.

- [ ] **Step 5: Implement the auth service and fixed `uid=1` administrator**

Configure the Drizzle adapter for SQLite and mixed IDs. Keep the user ID database-generated and use string IDs for auth-owned rows:

```ts
export class Authentication extends Service {
  static readonly provide = 'auth'
  static readonly inject = ['env', 'db']
  readonly instance

  constructor(ctx: Context) {
    super(ctx, 'auth')
    this.instance = betterAuth({
      database: drizzleAdapter(ctx.db.orm, { provider: 'sqlite', schema: authSchema }),
      baseURL: ctx.env.BETTER_AUTH_URL,
      secret: ctx.env.BETTER_AUTH_SECRET,
      advanced: {
        database: {
          generateId: ({ model }) => model === 'users' || model === 'user'
            ? false
            : crypto.randomUUID(),
        },
        ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      },
      emailAndPassword: { enabled: true },
      user: { modelName: 'users' },
      account: { modelName: 'authAccounts' },
      session: { modelName: 'authSessions' },
      verification: { modelName: 'authVerifications' },
      plugins: [adminPlugin({ adminUserIds: ['1'] })],
    })
  }
}
```

Adjust the exact schema/model option spelling to the inspected 1.7.3 types; do not guess past compiler errors. Register this service only on the Worker side, not inside UserHub.

- [ ] **Step 6: Remove default-user bootstrap and validate user IDs**

Delete `ensureDefaultUser()` and `DEFAULT_USER_ID`. Implement:

```ts
export function parseAuthUserId(value: string | number): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== String(value)) {
    throw new TypeError('invalid auth user id')
  }
  return id
}
```

Account for numeric input without rejecting `1` because `String(1) === '1'`; explicitly reject strings containing whitespace, decimals, signs, or leading zeroes in tests.

- [ ] **Step 7: Add required Worker bindings**

Add `BETTER_AUTH_SECRET` as a required secret, `BETTER_AUTH_URL` and `ALLOW_REGISTER` as string bindings, and test values:

```jsonc
"secrets": { "required": ["KEY_ENCRYPTION_SECRET", "BETTER_AUTH_SECRET"] },
"vars": {
  "BETTER_AUTH_URL": "https://chat.epb.wiki",
  "ALLOW_REGISTER": "false"
}
```

Document only placeholder names in `.dev.vars.example`; never add real secret values.

- [ ] **Step 8: Run focused and full validation**

Run:

```bash
pnpm vitest run --project unit test/unit/auth-user-id.test.ts
pnpm vitest run --project worker test/worker/auth-schema.test.ts test/worker/db.test.ts
pnpm typecheck
pnpm test
```

Expected: all pass and no test relies on automatic `uid=1` creation.

- [ ] **Step 9: Commit the auth foundation**

```bash
git add package.json pnpm-lock.yaml migrations src test vitest.config.ts wrangler.jsonc .dev.vars.example
git commit -m "feat(auth): add better auth foundation"
```

---

### Task 3: Enforce registration policy and protect Hono routes

**Files:**

- Create: `src/server/plugins/auth/site-settings.ts`
- Create: `src/server/plugins/auth/policy.ts`
- Create: `src/server/plugins/api/auth.ts`
- Create: `src/server/plugins/api/site-settings.ts`
- Create: `test/worker/auth.test.ts`
- Create: `test/worker/auth-helper.ts`
- Modify: `src/server/plugins/auth/index.ts`
- Modify: `src/server/plugins/api/index.ts`
- Modify: `src/server/cordis.d.ts`
- Modify: `src/shared/auth.ts`
- Modify: existing Worker tests that call protected endpoints

**Interfaces:**

- Consumes: `ctx.auth.instance`, `parseAuthUserId()`, `users`, `authAccounts`, `authSessions`.
- Produces: `resolveAllowRegister(db: DB, envValue: unknown): Promise<{ value: boolean; source: 'db' | 'env' | 'default' }>`.
- Produces: Hono context variable `authSession: typeof ctx.auth.instance.$Infer.Session`.
- Produces: `requireAuth`, `authUserId(c): number`, and `requireAdmin` helpers.
- Produces: `GET /api/site-settings`, `GET /api/admin/settings`, and `PUT /api/admin/settings`.

- [ ] **Step 1: Write failing registration and middleware integration tests**

Cover the exact bootstrap and migration cases:

```ts
it('rejects self-registration when registration is closed', async () => {
  const response = await json('POST', '/api/auth/sign-up/email', signupBody)
  expect(response.status).toBe(403)
})

it('makes the first registered user uid 1 when enabled', async () => {
  await setAllowRegister(true)
  const response = await json('POST', '/api/auth/sign-up/email', signupBody)
  expect(response.status).toBe(200)
  expect(await findUserByEmail(signupBody.email)).toMatchObject({ id: 1 })
})

it('does not claim an existing credential-less uid 1', async () => {
  await insertLegacyUserOne()
  await setAllowRegister(true)
  await json('POST', '/api/auth/sign-up/email', signupBody)
  expect(await findUserByEmail(signupBody.email)).toMatchObject({ id: 2 })
})

it('protects business APIs', async () => {
  expect((await json('GET', '/api/conversations')).status).toBe(401)
})
```

- [ ] **Step 2: Run the tests and verify policy failures**

Run:

```bash
pnpm vitest run --project worker test/worker/auth.test.ts
```

Expected: registration is not gated and business APIs remain public.

- [ ] **Step 3: Implement site-setting resolution**

Use the `site_settings(key PRIMARY KEY, value, updated_at)` table created in Task 2. Parse only case-insensitive `"true"` and `"false"`; an invalid D1 value is a server error, while an invalid environment value falls back to `false` with a warning that contains no secret data.

```ts
export async function resolveAllowRegister(db: DB, rawEnv: unknown): Promise<ResolvedBoolean> {
  const row = await db.query.siteSettings.findFirst({
    where: eq(siteSettings.key, 'auth.allow_register'),
  })
  if (row) return { value: parseStoredBoolean(row.value), source: 'db' }
  if (typeof rawEnv === 'string') return { value: rawEnv.toLowerCase() === 'true', source: 'env' }
  return { value: false, source: 'default' }
}
```

- [ ] **Step 4: Gate all public user creation paths in Better Auth**

Use Better Auth 1.7.3's `validateUserInfo`/hook context inspected in Task 2. Allow `source.method` representing Admin plugin creation; for email signup and future OAuth implicit signup, reject creation unless `resolveAllowRegister()` returns true. Do not gate sign-in or account linking to an existing user.

Add a second guard for `uid=1`: reject Admin plugin ban and role-demotion operations targeting user ID `"1"`. Keep this rule server-side even if the UI disables those buttons.

- [ ] **Step 5: Mount Better Auth and add the thin auth middleware**

Register the framework handler before other API routes:

```ts
app.all('/api/auth/*', c => ctx.auth.instance.handler(c.req.raw))

export const requireAuth = createMiddleware<ApiEnv>(async (c, next) => {
  const authSession = await ctx.auth.instance.api.getSession({ headers: c.req.raw.headers })
  if (!authSession) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authSession', authSession)
  await next()
})
```

Apply it to business `/api/*` routes and `/ws`, excluding `/api/health`, `/api/site-settings`, and `/api/auth/*`. Implement `requireAdmin` with Better Auth Admin permission checks rather than trusting a client-supplied role.

- [ ] **Step 6: Add authenticated Worker-test helpers**

Create helpers that enable registration, sign up through Better Auth, capture every `set-cookie` header, and send the resulting Cookie header. Tests must not forge AuthSession rows or bypass middleware:

```ts
export async function registerAndLogin(input: SignupInput): Promise<AuthTestClient> {
  const response = await workerFetch('/api/auth/sign-up/email', { method: 'POST', body: input })
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  return { cookie, request: (path, init) => workerFetch(path, withCookie(cookie, init)) }
}
```

Update existing Worker API tests to use this client. Keep authentication setup in helpers so individual tests remain about their business behavior.

- [ ] **Step 7: Verify auth routes and all prior behavior**

Run:

```bash
pnpm vitest run --project worker test/worker/auth.test.ts test/worker/api.test.ts
pnpm typecheck
pnpm test
```

Expected: all pass; unauthenticated business calls consistently return `401`.

- [ ] **Step 8: Commit policy and middleware**

```bash
git add src test migrations
git commit -m "feat(auth): enforce registration and route access"
```

---

### Task 4: Scope every REST resource to the authenticated user

**Files:**

- Create: `test/worker/tenant-isolation.test.ts`
- Modify: `src/server/plugins/api/{me,conversations,providers,provider-write,models,model-query,projects,attachments,model-catalog}.ts`
- Modify: `src/server/plugins/hub/{conversations,projects}.ts`
- Modify: `src/server/plugins/files-cleanup.ts` only if its helper signatures currently assume `uid=1`
- Modify: `test/worker/{api,model-query}.test.ts`
- Modify: `test/worker/provider-catalog-fixture.ts`

**Interfaces:**

- Consumes: `authUserId(c): number` from Task 3.
- Produces: every user-owned repository helper accepts `userId` and includes it in the SQL predicate.
- Produces: `/api/me` response composed from Better Auth identity plus the same user's application `settings`.

- [ ] **Step 1: Write failing two-user isolation tests**

Create two authenticated clients and resources for each. Assert that client B cannot list, read, edit, or delete client A's records:

```ts
expect(await alice.request('/api/providers')).toMatchObject({ status: 200 })
expect(await bob.request(`/api/providers/${aliceProvider.id}`)).toMatchObject({ status: 404 })
expect(await bob.request(`/api/conversations/${aliceConversation.id}/messages`)).toMatchObject({ status: 404 })
expect(await bob.request(`/api/attachments/${aliceAttachment.id}`)).toMatchObject({ status: 404 })
```

Also prove list endpoints return only the caller's rows and model lookup cannot escape through a known provider/model ID.

- [ ] **Step 2: Run the isolation tests and confirm leakage**

Run:

```bash
pnpm vitest run --project worker test/worker/tenant-isolation.test.ts
```

Expected: failures because routes still use the former default user or resource-ID-only helpers.

- [ ] **Step 3: Thread user ID through every REST route**

At the top of each handler, resolve the authenticated ID once:

```ts
const userId = authUserId(c)
const row = await db.query.attachments.findFirst({
  where: and(eq(attachments.id, attachmentId), eq(attachments.user_id, userId)),
})
if (!row) return c.json({ error: 'not found' }, 404)
```

Update Provider, model, Project, Conversation, attachment, and settings repository helpers to require `userId`; do not keep optional/default parameters. Nested resources must validate ownership through an owned parent query.

- [ ] **Step 4: Fix `/api/me` and application settings**

Use `authSession.user` for name/email/role and query `users.settings` by the same validated integer ID. Return a purpose-built DTO; do not expose `banned`, password data, AuthSession tokens, or Better Auth internal fields.

- [ ] **Step 5: Verify no production hard-coded identity remains**

Run:

```bash
rg -n "DEFAULT_USER_ID|user_id:\s*1|eq\([^,]+user_id,\s*1\)" src
```

Expected: no matches.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
pnpm vitest run --project worker test/worker/tenant-isolation.test.ts test/worker/api.test.ts test/worker/model-query.test.ts
pnpm typecheck
pnpm test
```

Expected: all pass.

- [ ] **Step 7: Commit REST isolation**

```bash
git add src test
git commit -m "fix(auth): isolate REST data by user"
```

---

### Task 5: Bind authenticated users and AuthSessions to UserHub

**Files:**

- Create: `src/server/plugins/hub/identity.ts`
- Create: `test/worker/hub-auth.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/plugins/api/index.ts`
- Modify: `src/server/plugins/hub/{index,generation,generated-images,conversations,projects}.ts`
- Modify: `test/worker/ws-helper.ts`
- Modify: `test/worker/{hub-do,hub-generation,hub-conversations}.test.ts`

**Interfaces:**

- Consumes: validated `authUserId` and Better Auth `authSession.session.id` from Task 3.
- Produces: Worker-only headers/constants `X-Only-Chat-User-Id` and `X-Only-Chat-Auth-Session-Id`.
- Produces: persisted DO owner key `identity:user-id` and socket attachment `{ authSessionId: string }`.
- Produces: `createApp({ side: 'hub', userId })` and `Hub.userId`.
- Produces: internal DO action `POST /internal/auth-revoked` that aborts work and closes all sockets for a banned user.

- [ ] **Step 1: Write failing authenticated WebSocket and cross-user tests**

Cover missing authentication, correct DO routing, cross-user command rejection, and AuthSession revocation:

```ts
expect((await connectWithoutCookie()).status).toBe(401)

const alice = await connect({ cookie: aliceClient.cookie })
const bob = await connect({ cookie: bobClient.cookie })
alice.ws.send(JSON.stringify({ type: 'conversation.delete', conversation_id: bobConversation.id }))
expect(await alice.next('error')).toMatchObject({ message: 'conversation not found' })

await revokeAuthSession(alice.authSessionId)
alice.ws.send(JSON.stringify({ type: 'conversation.update', conversation_id: aliceConversation.id, title: 'blocked' }))
await expectSocketClose(alice.ws)
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
pnpm vitest run --project worker test/worker/hub-auth.test.ts
```

Expected: `/ws` still routes every connection to `uid=1` and accepts unauthenticated clients.

- [ ] **Step 3: Authenticate and rewrite the internal upgrade request**

After Origin validation, create a fresh Request for the DO and overwrite both internal identity headers. Never forward client-provided values:

```ts
const userId = authUserId(c)
const authSessionId = c.get('authSession').session.id
const headers = new Headers(c.req.raw.headers)
headers.set(INTERNAL_USER_ID_HEADER, String(userId))
headers.set(INTERNAL_AUTH_SESSION_ID_HEADER, authSessionId)
const request = new Request(c.req.raw, { headers })
return c.env.USER_HUB.getByName(String(userId)).fetch(request)
```

- [ ] **Step 4: Persist and validate the UserHub owner**

On first fetch, persist `identity:user-id` before accepting the socket. On later fetches compare it with the Worker-set header. During hibernation reconstruction, read the persisted owner in `blockConcurrencyWhile` and initialize the Hub application with that ID. A mismatch returns `403` and never initializes a second identity.

Store `{ authSessionId }` with `server.serializeAttachment()` before `acceptWebSocket()`. Change `webSocketMessage` to pass the socket into `hub.handleCommand(ws, message)`.

- [ ] **Step 5: Scope every Hub operation to `Hub.userId`**

Add an immutable positive integer `userId` to Hub construction. Replace every former default identity in generation, Project mutation, Conversation mutation, generated-image lookup, settings updates, and R2 keys:

```ts
const conversation = await getConversation(hub.db, conversationId, hub.userId)
if (!conversation) throw new Error('conversation not found')
```

Repository functions that read or mutate user-owned records must take `userId`; no Hub call may update a record after an unowned ID-only lookup.

- [ ] **Step 6: Reject revoked AuthSessions and close banned users immediately**

Before dispatching each WebSocket command, read its attachment and require a non-expired `auth_sessions` row belonging to `Hub.userId` and a non-banned user. If validation fails, close that socket with an application close code and do not broadcast an error to other devices.

Add `Hub.revokeAccess()` that aborts every in-flight job, awaits settlement using the existing stop discipline, and closes every socket. Add a Better Auth Admin after-hook for successful user bans that calls the target UserHub's internal revoke action. The internal action is reachable only through the Worker binding and never mounted as a public Hono route.

- [ ] **Step 7: Update WebSocket helpers and run realtime tests**

Make `connect({ cookie })` mandatory outside explicit unauthenticated tests. Run:

```bash
pnpm vitest run --project worker \
  test/worker/hub-auth.test.ts \
  test/worker/hub-do.test.ts \
  test/worker/hub-generation.test.ts \
  test/worker/hub-conversations.test.ts
pnpm typecheck
pnpm test
```

Expected: all pass; two users receive no cross-user broadcasts.

- [ ] **Step 8: Commit UserHub isolation**

```bash
git add src test
git commit -m "fix(auth): bind user hubs to authenticated users"
```

---

### Task 6: Add frontend authentication state and entry pages

**Files:**

- Create: `src/client/lib/auth-client.ts`
- Create: `src/client/stores/auth.ts`
- Create: `src/client/pages/login.vue`
- Create: `src/client/pages/register.vue`
- Create: `src/client/views/auth-login.vue`
- Create: `src/client/views/auth-register.vue`
- Create: `test/unit/client-auth-store.test.ts`
- Create: `test/unit/client-auth-pages.test.ts`
- Modify: `src/client/main.ts`
- Modify: `src/client/app.vue`
- Modify: `src/client/router.ts`
- Modify: `src/client/lib/api.ts`
- Modify: `src/client/typed-router.d.ts`
- Modify: `test/unit/client-routes.test.ts`

**Interfaces:**

- Consumes: Better Auth `/api/auth/*`, `GET /api/site-settings`, and authenticated business APIs.
- Produces: `authClient`, `useAuthStore()`, `authStore.authSession`, `authStore.authUser`, `authStore.ready`, `authStore.refresh()`, and `authStore.signOut()`.
- Produces: route meta `requiresAuth` and `guestOnly`.

- [ ] **Step 1: Write failing auth-store and route-guard tests**

Test loading, redirect preservation, login success, registration visibility, and `401` handling:

```ts
expect(router.currentRoute.value.fullPath).toBe('/login?redirect=%2Fsettings%2Fproviders')
expect(authStore.ready).toBe(true)
expect(authStore.authUser).toMatchObject({ email: 'owner@example.com' })

apiError.status = 401
await expect(sync.loadConversations()).rejects.toThrow()
expect(authStore.authSession).toBeNull()
```

- [ ] **Step 2: Run the unit tests and verify failure**

Run:

```bash
pnpm vitest run --project unit test/unit/client-auth-store.test.ts test/unit/client-auth-pages.test.ts test/unit/client-routes.test.ts
```

Expected: missing store/pages and no auth-aware routing.

- [ ] **Step 3: Create the Better Auth Vue client and auth Store**

Create one client instance using same-origin `/api/auth`. The Store owns initialization and uses `authSession` naming even though Better Auth's client API method is `getSession()`:

```ts
const result = await authClient.getSession()
this.authSession = result.data
this.authUser = result.data?.user ?? null
this.ready = true
```

Do not open the WebSocket or load private collections until `ready && authUser`.

- [ ] **Step 4: Add typed HTTP errors and global `401` handling**

Replace string-only API errors with `ApiError { status, detail }`. On `401`, clear frontend auth state and redirect through the router guard; do not treat `403` as logout. Preserve endpoint-specific error text without exposing response bodies that are not JSON error objects.

- [ ] **Step 5: Add login and registration pages**

Use existing shadcn-vue `Card`, `Field`, `Input`, `Button`, and alert components. Login submits `authClient.signIn.email`; registration submits `authClient.signUp.email`. Disable submit while pending and map framework errors to concise Chinese UI messages. Registration page fetches public site settings and replaces the form with “注册未开放” when false; backend enforcement remains authoritative.

- [ ] **Step 6: Gate application startup and routes**

Initialize auth before sync/config:

```ts
onMounted(async () => {
  await auth.refresh()
  if (!auth.authUser) return
  sync.connect()
  await Promise.allSettled([
    sync.loadSettings(),
    sync.loadConversations(),
    sync.loadProjects(),
    config.load(),
  ])
})
```

Add route guards that preserve only same-origin relative destinations. Prevent authenticated users from remaining on guest-only login/register pages.

- [ ] **Step 7: Run frontend and full verification**

Run:

```bash
pnpm vitest run --project unit \
  test/unit/client-auth-store.test.ts \
  test/unit/client-auth-pages.test.ts \
  test/unit/client-routes.test.ts \
  test/unit/client-sync-store.test.ts
pnpm typecheck
pnpm test
```

Expected: all pass.

- [ ] **Step 8: Commit frontend authentication**

```bash
git add src test
git commit -m "feat(auth): add login and registration flows"
```

---

### Task 7: Add account settings and minimal administration UI

**Files:**

- Create: `src/client/pages/settings/account.vue`
- Create: `src/client/pages/admin/index.vue`
- Create: `src/client/pages/admin/settings.vue`
- Create: `src/client/pages/admin/users.vue`
- Create: `src/client/views/settings-account.vue`
- Create: `src/client/views/admin-settings.vue`
- Create: `src/client/views/admin-users.vue`
- Rename: `src/client/components/layout/sidebar-account-placeholder.vue` → `src/client/components/layout/sidebar-account-menu.vue`
- Create: `test/unit/client-account-menu.test.ts`
- Create: `test/unit/client-admin.test.ts`
- Create: `test/worker/admin.test.ts`
- Modify: `src/client/components/layout/sidebar-global-footer.vue`
- Modify: `src/client/components/layout/settings-sidebar-content.vue`
- Modify: `src/client/lib/auth-client.ts`
- Modify: `src/client/lib/api.ts`
- Modify: `src/client/typed-router.d.ts`
- Modify: `src/server/plugins/api/site-settings.ts`
- Modify: `src/shared/auth.ts`

**Interfaces:**

- Consumes: Better Auth Admin endpoints and `GET/PUT /api/admin/settings`.
- Produces: account menu, account settings, admin settings, and admin users pages.
- Produces: admin actions limited to create, list, set role, ban/unban, set password, and revoke AuthSessions.

- [ ] **Step 1: Write failing server authorization and UI tests**

Server tests must prove ordinary users receive `403`, admins can manage accounts, and `uid=1` cannot be demoted or banned:

```ts
expect((await member.request('/api/admin/settings')).status).toBe(403)
expect((await owner.request('/api/auth/admin/ban-user', {
  method: 'POST', body: { userId: '1' },
})).status).toBe(403)
```

UI tests must assert the account menu shows the real name/email, ordinary users do not see admin navigation, and admins do.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm vitest run --project worker test/worker/admin.test.ts
pnpm vitest run --project unit test/unit/client-account-menu.test.ts test/unit/client-admin.test.ts
```

Expected: missing pages/actions and existing placeholder identity remains.

- [ ] **Step 3: Restrict Better Auth Admin permissions**

Configure custom Admin access statements so the exposed admin role has only the required user/session actions. Exclude user deletion, impersonation, email replacement, and application-data access even if Better Auth ships those endpoints. Verify excluded endpoints return `403` in Worker tests.

- [ ] **Step 4: Implement account settings and real sidebar identity**

Replace the placeholder with a dropdown showing `authUser.name` and `authUser.email`, linking to account settings and calling `authStore.signOut()`. Account settings supports name update and password change with `revokeOtherSessions: true`; it does not expose email modification or recovery.

- [ ] **Step 5: Implement registration settings administration**

Show the effective `allowRegister` value and source. Saving writes a D1 override; “恢复部署配置” deletes the D1 row. After either operation, refetch public settings so the login/register UI sees the new value.

- [ ] **Step 6: Implement minimal user administration**

Use Better Auth Admin client methods for paginated list, create, role update, ban, unban, password reset, and AuthSession revoke. Disable ban/demotion actions for `uid=1` in UI while retaining Task 3's server guard. Do not fetch or link any business-resource counts.

- [ ] **Step 7: Run admin, UI, and full tests**

Run:

```bash
pnpm vitest run --project worker test/worker/admin.test.ts test/worker/auth.test.ts
pnpm vitest run --project unit test/unit/client-account-menu.test.ts test/unit/client-admin.test.ts
pnpm typecheck
pnpm test
```

Expected: all pass and admin responses contain account metadata only.

- [ ] **Step 8: Commit account administration**

```bash
git add src test
git commit -m "feat(auth): add account administration"
```

---

### Task 8: Add the generic Wrangler credential-reset command

**Files:**

- Create: `scripts/reset-user-credentials.ts`
- Create: `scripts/lib/reset-user-credentials.ts`
- Create: `test/unit/reset-user-credentials.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Better Auth 1.7.3 password hash implementation and D1 schema from Task 2.
- Produces: `pnpm auth:reset-user -- --userid <id> --local|--remote`.
- Produces: pure `parseResetArgs()`, `escapeSqlLiteral()`, and `buildResetSql()` functions for tests.

- [ ] **Step 1: Inspect Wrangler and Better Auth's installed command APIs**

Run:

```bash
pnpm wrangler d1 execute --help
rg -n "hashPassword" node_modules/better-auth -g '*.d.ts' -g 'package.json' | head -40
```

Use the verified `better-auth/crypto` export if present in 1.7.3. If it is not public in the installed package, configure and export the exact same password hash function from `src/server/plugins/auth/index.ts` and import that implementation in the script; never duplicate hashing parameters.

- [ ] **Step 2: Write failing parser, SQL-safety, and transaction tests**

Cover missing/malformed IDs, mutually exclusive environment flags, quotes/newlines in names, email conflicts, and preservation of business rows:

```ts
expect(() => parseResetArgs(['--userid', '1'])).toThrow(/local.*remote/i)
expect(() => parseResetArgs(['--userid', '01', '--local'])).toThrow(/userid/i)
expect(escapeSqlLiteral("O'Brien")).toBe("'O''Brien'")
expect(buildResetSql(input)).toContain('DELETE FROM auth_sessions')
expect(buildResetSql(input)).not.toContain('BEGIN TRANSACTION')
expect(buildResetSql(input)).not.toContain(input.password)
```

- [ ] **Step 3: Run unit tests and verify failure**

Run:

```bash
pnpm vitest run --project unit test/unit/reset-user-credentials.test.ts
```

Expected: reset modules do not exist.

- [ ] **Step 4: Implement safe argument parsing and interactive prompts**

Add a dev-only prompt dependency with hidden password input:

```bash
pnpm add -D @inquirer/prompts
```

Require exactly one of `--local` and `--remote`, and require canonical positive `--userid`. Query the target row through `pnpm wrangler d1 execute DB ... --json` before prompting. Display environment, user ID, and current email, then require an explicit confirmation. Prompt for name, normalized email, password, and password confirmation; never accept password through argv.

- [ ] **Step 5: Build and execute one atomic Wrangler D1 file**

Hash the password before creating SQL. Generate new auth-account IDs with `crypto.randomUUID()`. Write a temporary SQL file in an OS temporary directory containing only the password hash, never plaintext. Execute the file in one `wrangler d1 execute DB --file ...` call. D1 file ingestion provides rollback on failure; omit explicit `BEGIN TRANSACTION` and `COMMIT`, which D1 import guidance rejects.

```sql
DELETE FROM auth_sessions WHERE user_id = :user_id;
DELETE FROM auth_accounts WHERE user_id = :user_id;
UPDATE users
SET name = :name, email = :email, email_verified = 0, updated_at = :now
WHERE id = :user_id;
INSERT INTO auth_accounts
  (id, account_id, provider_id, user_id, password, created_at, updated_at)
SELECT :account_row_id, CAST(id AS TEXT), 'credential', id, :password_hash, :now, :now
FROM users WHERE id = :user_id AND email = :email;
```

The displayed `:names` describe builder substitutions; the emitted file contains fully escaped literals because Wrangler's file command does not bind parameters. The unique email index aborts the file on conflicts, and the credential insert selects the post-update user so a missing/changed target cannot create an orphan account. Verify the affected user and credential after execution, and remove the temporary file in `finally`.

- [ ] **Step 6: Verify the reset against a disposable local D1 database**

Add a test seam for the Wrangler subprocess and test the pure SQL builder. Include an injected-final-statement failure case proving the file is rolled back locally. Then manually run against the worktree's disposable local test data:

```bash
pnpm auth:reset-user -- --userid 1 --local
```

Expected: the command shows the local target, prompts without echoing the password, resets only auth credentials/AuthSessions, and a subsequent login succeeds. Confirm Conversation, Provider, Project, and attachment row counts for that user are unchanged.

- [ ] **Step 7: Run script tests and security scans**

Run:

```bash
pnpm vitest run --project unit test/unit/reset-user-credentials.test.ts
rg -n "password.*console|console.*password|--password" scripts src/server/plugins/auth
pnpm typecheck
pnpm test
```

Expected: tests pass; the scan finds no password logging or password CLI flag.

- [ ] **Step 8: Commit the recovery command**

```bash
git add scripts test package.json pnpm-lock.yaml
git commit -m "feat(auth): add credential reset command"
```

---

### Task 9: Update deployment documentation and run final verification

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-05-only-chat-mvp-design.md`
- Modify: any current design document that still presents hard-coded `uid=1` or chat `Session` naming as current behavior
- Test: all existing tests

**Interfaces:**

- Consumes: all prior tasks.
- Produces: deployment and upgrade instructions matching the implemented schema and authentication behavior.

- [ ] **Step 1: Write the final documentation changes**

Document:

- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `ALLOW_REGISTER` setup;
- default-closed registration and how to enable it;
- first-user `uid=1` administrator behavior;
- `auth:reset-user` local/remote usage without password arguments;
- the coordinated D1 migration/Worker deployment requirement;
- Cloudflare Access removal as an explicit deployment-time decision;
- Conversation naming in architecture, REST, WebSocket, and schema sections.

Mark the MVP design's “No authentication” and hard-coded `user_id` sections as superseded by the new spec rather than leaving contradictory current instructions.

- [ ] **Step 2: Search for stale behavior and ambiguous naming**

Run:

```bash
rg -n "DEFAULT_USER_ID|No authentication|No authentication yet|hard-coded|硬编码|/api/sessions|session_id|session\." \
  README.md src test docs/superpowers/specs \
  -g '!src/client/ui/**' \
  -g '!docs/superpowers/plans/**'
```

Expected: only explicitly historical/superseded documentation or Better Auth framework method names. Inspect every match.

- [ ] **Step 3: Run migration, type, test, and build verification**

Run:

```bash
pnpm db:migrate:local
pnpm typecheck
pnpm test
pnpm build
git diff --check main...HEAD
git status -sb
```

Expected: migrations apply cleanly; typecheck, 62+ test files, and production build pass; no whitespace errors or uncommitted generated files remain.

- [ ] **Step 4: Commit documentation and final cleanup**

```bash
git add README.md docs
git commit -m "docs: document user authentication deployment"
```

- [ ] **Step 5: Inspect the complete branch without pushing**

Run:

```bash
git log --oneline main..HEAD
git diff --stat main...HEAD
git status -sb
```

Expected: focused Conventional Commits, a clean worktree, and no push. Present the branch for user review.
