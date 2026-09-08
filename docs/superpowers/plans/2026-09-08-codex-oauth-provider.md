# Codex OAuth Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently selectable Codex providers authenticated with ChatGPT device-code OAuth and served directly from Cloudflare Workers.

**Architecture:** A hub-side Codex service owns device-code state, encrypted credentials, refresh serialization, and fixed upstream calls. Worker REST routes delegate credential-sensitive operations to the user's `UserHub`, while existing D1 model reconciliation and AI SDK streaming remain the application-facing boundaries. Provider-kind dispatch selects the dedicated Codex transport before the generic protocol adapters.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, D1/Drizzle, Hono, Vue 3/Pug, AI SDK 7 with `@ai-sdk/open-responses`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-codex-oauth-provider-design.md`

## Global Constraints

- Work only in the `feat/codex-oauth` worktree rooted at `/Users/xiaoyujun/GitRepositories/_worktrees/only-chat/feat-codex-oauth`.
- Keep custom-provider behavior and the four existing interface protocols unchanged.
- Codex endpoints, protocol, OAuth client ID, scopes, headers, and Files capability are code constants and never client input.
- A user may create several Codex providers, but one ChatGPT account may back only one provider for that user.
- No account pooling, automatic provider switching, proactive cron refresh, Files, image generation, image-only models, Realtime, voice, WebSocket Responses, remote compaction, or Claude OAuth.
- Tokens, authorization codes, device authorization IDs, user codes, account IDs, and raw authorization headers never appear in logs or public DTOs.
- Use TDD for production behavior. Tests cover bugs and contracts, not exact copy or private implementation structure.
- Run the smallest relevant test target after each step and `pnpm typecheck && pnpm test && pnpm build` before completion.

---

## File Map

**New server units**

- `src/server/plugins/codex/constants.ts`: fixed OpenAI URLs, public client ID, refresh skew, and request identity.
- `src/server/plugins/codex/types.ts`: private token, pending-flow, identity, and error types.
- `src/server/plugins/codex/client.ts`: device-code, token, revoke, and model-list HTTP protocol.
- `src/server/plugins/codex/credentials.ts`: encrypted D1 credential repository and compare-and-swap writes.
- `src/server/plugins/codex/flow.ts`: Durable Object pending-flow state machine.
- `src/server/plugins/codex/index.ts`: hub-side Codex service, refresh single-flight, and public service boundary.
- `src/server/plugins/llm/providers/codex.ts`: dedicated AI SDK Responses adapter and request normalization.
- `src/server/plugins/api/codex.ts`: public REST routes that delegate to `UserHub` RPC.
- `src/server/plugins/api/provider-read.ts`: kind-aware provider DTO loading without credential disclosure.
- `src/server/plugins/api/provider-model-sync.ts`: shared D1 model reconciliation extracted from the provider route.

**New client unit**

- `src/client/components/codex-oauth-dialog.vue`: start, device-code display, throttled polling, cancellation, and terminal states.

**Primary modified units**

- `src/server/db/schema.ts`, `migrations/0006_codex-oauth.sql`, `migrations/meta/*`: provider kind and OAuth credential persistence.
- `src/shared/models.ts`, `src/shared/api.ts`: discriminated provider and OAuth wire contracts.
- `src/server/app.ts`, `src/server/cordis.d.ts`, `src/server/index.ts`: service registration and typed Durable Object RPC.
- `src/server/plugins/llm/index.ts`: provider-kind adapter registry.
- `src/server/plugins/api/index.ts`, `src/server/plugins/api/providers.ts`, `src/server/plugins/api/provider-write.ts`: routing, fixed-provider writes, sync, revoke, and delete.
- `src/client/lib/api.ts`, `src/client/lib/provider-settings.ts`: OAuth calls and kind-aware drafts.
- `src/client/components/provider-create-dialog.vue`, `src/client/components/provider-navigation.vue`: dedicated creation entry and status badges.
- `src/client/views/settings-provider-edit.vue`: restricted Codex settings and credential actions.
- `README.md`: Codex setup, behavior, and exclusions.

---

### Task 1: Persist Provider Kind and OAuth Credential State

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/shared/models.ts`
- Create: `migrations/0006_codex-oauth.sql`
- Modify: `test/unit/shared-models.test.ts`
- Modify: `test/worker/db.test.ts`
- Modify: `test/unit/provider-fixtures.ts`

**Interfaces:**
- Produces: `ProviderKind = 'custom' | 'codex-oauth'`.
- Produces: `OAuthCredentialStatus = 'connected' | 'reconnect-required' | 'disconnected'`.
- Produces: `providerOAuthCredentials` Drizzle table and `ProviderOAuthCredentialRow`.
- Produces: public `CodexOAuthSummary` embedded in Codex provider DTOs.

- [ ] **Step 1: Write failing shared-schema tests**

Add cases proving existing fixtures default to `custom`, Codex DTOs require an OAuth summary, and public schemas reject token-shaped fields:

```ts
expect(ProviderWithInterfacesSchema.parse({
  id: 1,
  user_id: 1,
  name: 'Custom',
  kind: 'custom',
  has_key: false,
  enabled: true,
  default_interface_id: 10,
  credential_version: 1,
  models_dev_provider_id: null,
  models_dev_provider_source: null,
  interfaces: [{ id: 10, provider_id: 1, protocol: 'responses', base_url: 'https://example.test/v1', native_files: false, created_at: 0 }],
  created_at: 0,
})).toMatchObject({ kind: 'custom' })

expect(() => ProviderWithInterfacesSchema.parse({
  id: 2,
  user_id: 1,
  name: 'Codex',
  kind: 'codex-oauth',
  has_key: false,
  enabled: true,
  default_interface_id: 20,
  credential_version: 1,
  models_dev_provider_id: 'openai',
  models_dev_provider_source: 'manual',
  interfaces: [{ id: 20, provider_id: 2, protocol: 'responses', base_url: 'https://chatgpt.com/backend-api/codex', native_files: false, created_at: 0 }],
  oauth: { status: 'connected', account_email: 'me@example.com', access_expires_at: 1, access_token: 'forbidden' },
  created_at: 0,
})).toThrow()
```

- [ ] **Step 2: Run the shared-schema test and confirm failure**

Run: `pnpm vitest run --project unit test/unit/shared-models.test.ts`

Expected: FAIL because provider kind and OAuth summary schemas do not exist.

- [ ] **Step 3: Add the shared discriminated contracts**

Define exact public shapes in `src/shared/models.ts`:

```ts
export const ProviderKindSchema = z.enum(['custom', 'codex-oauth'])
export type ProviderKind = z.infer<typeof ProviderKindSchema>

export const OAuthCredentialStatusSchema = z.enum(['connected', 'reconnect-required', 'disconnected'])
export type OAuthCredentialStatus = z.infer<typeof OAuthCredentialStatusSchema>

export const CodexOAuthSummarySchema = z.strictObject({
  status: OAuthCredentialStatusSchema,
  account_email: z.string().email(),
  access_expires_at: z.number().int().nullable(),
  last_error: z.string().nullable(),
})
```

Make `ProviderWithInterfacesSchema` a discriminated union on `kind`. The `custom` branch keeps `has_key`; the `codex-oauth` branch requires `has_key: false` and `oauth: CodexOAuthSummarySchema`.

- [ ] **Step 4: Write failing migration tests**

Add D1 assertions:

```ts
const columns = await env.DB.prepare("PRAGMA table_info('provider_oauth_credentials')").all<{ name: string }>()
expect(columns.results.map(column => column.name)).toEqual([
  'provider_id', 'status', 'encrypted_bundle', 'account_id', 'account_email',
  'access_expires_at', 'revision', 'last_error', 'updated_at',
])

const provider = await env.DB.prepare('SELECT kind FROM providers ORDER BY id LIMIT 1').first<{ kind: string }>()
expect(provider?.kind).toBe('custom')
```

- [ ] **Step 5: Add and inspect the migration**

Add `kind` and `providerOAuthCredentials` to `src/server/db/schema.ts`. Create `migrations/0006_codex-oauth.sql` by hand because `0005_project-icons.sql` is intentionally not represented in the current Drizzle journal; running `db:generate` from the 0004 snapshot would reproduce unrelated project-icon state. The migration contains:

```sql
ALTER TABLE `providers` ADD `kind` text DEFAULT 'custom' NOT NULL;
CREATE TABLE `provider_oauth_credentials` (
  `provider_id` integer PRIMARY KEY NOT NULL,
  `status` text NOT NULL,
  `encrypted_bundle` text,
  `account_id` text NOT NULL,
  `account_email` text NOT NULL,
  `access_expires_at` integer,
  `revision` integer DEFAULT 1 NOT NULL,
  `last_error` text,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
```

Add checks for provider kind, OAuth status, and bundle presence: `disconnected` requires a null bundle, while `connected` and `reconnect-required` require a non-null bundle. Do not modify `migrations/meta`; this repository's current migration sequence already treats 0005 as a hand-written migration outside the journal. If another branch has occupied migration number `0006` before integration, renumber this migration during the later rebase.

- [ ] **Step 6: Run schema and database tests**

Run: `pnpm vitest run --project unit test/unit/shared-models.test.ts && pnpm vitest run --project worker test/worker/db.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the persistence contract**

```bash
git add src/server/db/schema.ts src/shared/models.ts migrations/0006_codex-oauth.sql test/unit/shared-models.test.ts test/worker/db.test.ts test/unit/provider-fixtures.ts
git commit -m "feat(providers): add OAuth credential schema"
```

---

### Task 2: Implement the Fixed Codex OAuth HTTP Client

**Files:**
- Create: `src/server/plugins/codex/constants.ts`
- Create: `src/server/plugins/codex/types.ts`
- Create: `src/server/plugins/codex/client.ts`
- Create: `test/unit/codex-client.test.ts`

**Interfaces:**
- Produces: `createCodexClient(fetchFn?: typeof fetch, now?: () => number): CodexClient`.
- Produces: `CodexClient.requestDeviceCode()`, `pollDeviceCode()`, `exchangeDeviceCode()`, `refreshTokens()`, `revoke()`, and `listModels()`.
- Produces: `CodexTokenBundle`, `CodexIdentity`, and `CodexProtocolError`.

- [ ] **Step 1: Write failing device and token protocol tests**

Use a recording fetch stub and assert fixed URLs and bodies:

```ts
const client = createCodexClient(fetchStub)
const grant = await client.requestDeviceCode()
expect(grant).toEqual({
  deviceAuthId: 'device-1',
  userCode: 'ABCD-EFGH',
  verificationUrl: 'https://auth.openai.com/codex/device',
  intervalMs: 5000,
  expiresAt: 900000,
})
expect(requests[0]).toMatchObject({
  url: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  method: 'POST',
})
```

Cover numeric and string polling intervals, 403/404 pending responses, an authorized response carrying `authorization_code` and `code_verifier`, token exchange, refresh-token rotation, model IDs sorted and deduplicated, revoke success, and sanitized errors.

- [ ] **Step 2: Run the client test and confirm failure**

Run: `pnpm vitest run --project unit test/unit/codex-client.test.ts`

Expected: FAIL because the Codex client modules do not exist.

- [ ] **Step 3: Define private types and fixed constants**

Use these boundaries:

```ts
export interface CodexTokenBundle {
  idToken: string
  accessToken: string
  refreshToken: string
  tokenType: string
  accountId: string
  email: string
  expiresAt: number
}

export type CodexDevicePoll =
  | { status: 'pending' }
  | { status: 'authorized'; authorizationCode: string; codeVerifier: string; codeChallenge: string }

export const CODEX_AUTH_BASE_URL = 'https://auth.openai.com'
export const CODEX_API_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'
export const CODEX_REFRESH_SKEW_MS = 300_000
export const CODEX_ORIGINATOR = 'codex_cli_rs'
```

- [ ] **Step 4: Implement the HTTP client with strict response parsing**

Implement this exact interface:

```ts
export interface CodexClient {
  requestDeviceCode(signal?: AbortSignal): Promise<CodexDeviceGrant>
  pollDeviceCode(deviceAuthId: string, userCode: string, signal?: AbortSignal): Promise<CodexDevicePoll>
  exchangeDeviceCode(poll: Extract<CodexDevicePoll, { status: 'authorized' }>, signal?: AbortSignal): Promise<CodexTokenBundle>
  refreshTokens(current: CodexTokenBundle, signal?: AbortSignal): Promise<CodexTokenBundle>
  revoke(refreshToken: string, signal?: AbortSignal): Promise<void>
  listModels(credentials: Pick<CodexTokenBundle, 'accessToken' | 'accountId'>, signal?: AbortSignal): Promise<string[]>
}
```

`createCodexClient` accepts a clock so the fixed 15-minute device-code expiry is deterministic in tests. Parse the ID token payload with base64url decoding to obtain account ID and email. Do not log token payloads. Preserve the current token field when a successful refresh omits its replacement. Classify known refresh errors as permanent and all network/5xx failures as transient. Request model discovery with the fixed `CODEX_CLIENT_VERSION = '0.153.4'` as `client_version`. Parse `{ models: [{ slug, supported_in_api }] }` and retain every valid model for ChatGPT authentication, including `supported_in_api: false`; this flag describes public API availability.

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run --project unit test/unit/codex-client.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the Codex protocol client**

```bash
git add src/server/plugins/codex test/unit/codex-client.test.ts
git commit -m "feat(codex): add OAuth protocol client"
```

---

### Task 3: Add Encrypted Credential Storage and Refresh CAS

**Files:**
- Create: `src/server/plugins/codex/credentials.ts`
- Create: `test/worker/codex-credentials.test.ts`
- Modify: `src/server/plugins/llm/crypto.ts`
- Modify: `test/unit/llm-crypto.test.ts`

**Interfaces:**
- Consumes: `CodexTokenBundle` from Task 2 and `providerOAuthCredentials` from Task 1.
- Produces: `CodexCredentialStore` with `read`, `createProvider`, `reconnect`, `storeRefresh`, `markReconnectRequired`, and `disconnect`.
- Produces: `CodexCredentialSnapshot` containing decrypted credentials plus revision and provider credential version.

- [ ] **Step 1: Add failing encrypted-JSON and lifecycle tests**

Test that ciphertext never contains token text and that round-tripping preserves the bundle:

```ts
const encrypted = await encryptJson(secret, tokenBundle)
expect(encrypted).not.toContain(tokenBundle.accessToken)
expect(await decryptJson<CodexTokenBundle>(secret, encrypted)).toEqual(tokenBundle)
```

In the Worker test, cover atomic provider/interface/credential creation, duplicate account rejection, same-account reconnect, different-account rejection, refresh revision CAS, stale failure suppression, disconnect, and credential-version behavior.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm vitest run --project unit test/unit/llm-crypto.test.ts && pnpm vitest run --project worker test/worker/codex-credentials.test.ts`

Expected: FAIL because JSON helpers and the credential store do not exist.

- [ ] **Step 3: Add typed JSON encryption helpers**

Extend `crypto.ts` without changing the existing string API:

```ts
export async function encryptJson(valueSecret: string, value: unknown): Promise<string> {
  return encryptSecret(valueSecret, JSON.stringify(value))
}

export async function decryptJson<T>(valueSecret: string, ciphertext: string): Promise<T> {
  return JSON.parse(await decryptSecret(valueSecret, ciphertext)) as T
}
```

- [ ] **Step 4: Implement the credential repository**

Expose this constructor and methods:

```ts
export class CodexCredentialStore {
  constructor(readonly db: DB, readonly encryptionSecret: string) {}
  read(providerId: number): Promise<CodexCredentialSnapshot | null>
  createProvider(bundle: CodexTokenBundle, now: number): Promise<number>
  reconnect(providerId: number, expectedRevision: number, bundle: CodexTokenBundle, now: number): Promise<void>
  storeRefresh(snapshot: CodexCredentialSnapshot, bundle: CodexTokenBundle, now: number): Promise<boolean>
  markReconnectRequired(snapshot: CodexCredentialSnapshot, message: string, now: number): Promise<boolean>
  disconnect(providerId: number, expectedRevision: number, now: number): Promise<boolean>
}
```

Use one D1 batch for provider creation. Use conditional `WHERE provider_id = ? AND revision = ? AND encrypted_bundle IS ?` writes for refresh, terminal failure, reconnect, and disconnect. Return `false` on stale CAS instead of overwriting current state.

- [ ] **Step 5: Run credential tests**

Run: `pnpm vitest run --project unit test/unit/llm-crypto.test.ts && pnpm vitest run --project worker test/worker/codex-credentials.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit credential persistence**

```bash
git add src/server/plugins/codex/credentials.ts src/server/plugins/llm/crypto.ts test/worker/codex-credentials.test.ts test/unit/llm-crypto.test.ts
git commit -m "feat(codex): persist OAuth credentials safely"
```

---

### Task 4: Extract Reusable Provider Model Reconciliation

**Files:**
- Create: `src/server/plugins/api/provider-model-sync.ts`
- Modify: `src/server/plugins/api/providers.ts`
- Modify: `test/worker/api.test.ts`

**Interfaces:**
- Produces: `reconcileProviderModels(ctx: Context, providerId: number, ids: readonly string[], options?: { enableNew?: boolean }): Promise<FetchModelsResponse>`.
- Preserves: current missing/imported/unavailable/manual-pinned behavior and model-source fences.

- [ ] **Step 1: Write a failing direct-service reconciliation test**

Add a test that invokes the extracted service twice and verifies the same state transitions as the existing route:

```ts
expect(await reconcileProviderModels(ctx, provider.id, ['model-a', 'model-b'])).toEqual({
  imported: 2,
  removed: 0,
  unavailable: 0,
  models: ['model-a', 'model-b'],
})
expect(await reconcileProviderModels(ctx, provider.id, ['model-b'])).toMatchObject({
  imported: 0,
  removed: 1,
})
expect(await reconcileProviderModels(ctx, provider.id, ['model-b', 'model-c'], { enableNew: true })).toMatchObject({ imported: 1 })
```

- [ ] **Step 2: Run the API test and confirm failure**

Run: `pnpm vitest run --project worker test/worker/api.test.ts`

Expected: FAIL because `reconcileProviderModels` does not exist.

- [ ] **Step 3: Move reconciliation without changing behavior**

Move the D1 retry, catalog lookup, source fences, inserts, updates, and deletes out of the Hono handler. The existing route becomes:

```ts
const ids = await listRemoteModels(endpoint, key)
return c.json(await reconcileProviderModels(ctx, id, ids))
```

Keep Hono-specific status mapping in `providers.ts`; the service throws `ModelSourceConflict` unchanged. New rows use `enabled: options.enableNew === true`. Existing custom-provider and manual-refresh callers omit the option and retain disabled-by-default imports.

- [ ] **Step 4: Run provider and model tests**

Run: `pnpm vitest run --project worker test/worker/api.test.ts test/worker/model-query.test.ts`

Expected: PASS with no changed custom-provider results.

- [ ] **Step 5: Commit the extraction**

```bash
git add src/server/plugins/api/provider-model-sync.ts src/server/plugins/api/providers.ts test/worker/api.test.ts
git commit -m "refactor(providers): extract model reconciliation"
```

---

### Task 5: Build the Durable OAuth Flow and REST Boundary

**Files:**
- Create: `src/server/plugins/codex/flow.ts`
- Create: `src/server/plugins/codex/index.ts`
- Create: `src/server/plugins/api/codex.ts`
- Create: `src/server/plugins/api/provider-read.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/cordis.d.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/plugins/api/index.ts`
- Modify: `src/server/plugins/api/providers.ts`
- Modify: `src/server/plugins/api/provider-write.ts`
- Modify: `src/shared/api.ts`
- Create: `test/worker/codex-oauth.test.ts`
- Modify: `test/worker/hub-do.test.ts`

**Interfaces:**
- Consumes: Codex HTTP client, credential store, and model reconciliation from Tasks 2-4.
- Produces: public `Codex` Cordis service.
- Produces: `UserHub.startCodexOAuth`, `pollCodexOAuth`, and `cancelCodexOAuth` RPC methods.
- Produces: REST start, poll, cancel, and reconnect-start routes.
- Produces: `readProviderDto(ctx, providerId)` and `listProviderDtos(ctx)` with kind-aware OAuth summaries.

- [ ] **Step 1: Write failing OAuth route tests**

Cover start, poll throttling, completion, cancellation, timeout, duplicate-account conflict, reconnect account matching, and model-sync warning. Assert no provider exists before completion:

```ts
const start = await request('POST', '/codex/oauth/start')
expect(start.status).toBe(201)
const grant = CodexOAuthStartResponseSchema.parse(await start.json())
expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM providers WHERE kind = 'codex-oauth'").first()).toEqual({ count: 0 })

const complete = await request('POST', `/codex/oauth/${grant.flow_id}/poll`)
expect(CodexOAuthPollResponseSchema.parse(await complete.json())).toMatchObject({
  status: 'complete',
  provider: { kind: 'codex-oauth', oauth: { status: 'connected' } },
})
```

- [ ] **Step 2: Run the OAuth tests and confirm failure**

Run: `pnpm vitest run --project worker test/worker/codex-oauth.test.ts test/worker/hub-do.test.ts`

Expected: FAIL because the routes, service, and RPC methods do not exist.

- [ ] **Step 3: Add strict public OAuth schemas**

Define these shared contracts in `src/shared/api.ts`:

```ts
export const CodexOAuthStartResponseSchema = z.strictObject({
  flow_id: z.string().uuid(),
  verification_url: z.string().url(),
  user_code: z.string().min(1),
  expires_at: z.number().int(),
  poll_interval_ms: z.number().int().positive(),
})

export const CodexOAuthPollResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending'), next_poll_at: z.number().int() }),
  z.strictObject({ status: z.literal('complete'), provider: ProviderWithInterfacesSchema, model_sync_warning: z.string().optional() }),
  z.strictObject({ status: z.literal('failed'), error: z.string() }),
])
```

- [ ] **Step 4: Implement encrypted Durable Object pending state**

`CodexOAuthFlowStore` uses `DurableObjectStorage` keys `codex-oauth:<flow-id>`. Store the upstream device authorization ID and user code only inside the encrypted record. Its public projection contains no device authorization ID.

Implement:

```ts
export class CodexOAuthFlowStore {
  constructor(readonly storage: DurableObjectStorage, readonly encryptionSecret: string) {}
  create(input: CodexPendingFlow): Promise<CodexOAuthStartResponse>
  read(flowId: string, now: number): Promise<CodexPendingFlow | null>
  update(flow: CodexPendingFlow): Promise<void>
  delete(flowId: string): Promise<boolean>
}
```

- [ ] **Step 5: Register the hub-side Codex service and RPC methods**

Load `CodexPlugin` before `LlmPlugin` in hub-side `createApp`. Add typed delegates to `UserHub`:

```ts
async startCodexOAuth(providerId?: number) {
  return this._app.codex.start(providerId)
}

async pollCodexOAuth(flowId: string) {
  return this._app.codex.poll(flowId)
}

async cancelCodexOAuth(flowId: string) {
  return this._app.codex.cancel(flowId)
}
```

Each browser poll causes at most one upstream poll. A call before `nextPollAt` returns pending without network I/O. Completion deletes the flow before returning.

The internal RPC completion result is `{ status: 'complete', providerId, modelIds, modelListError }`. After credential creation commits, the service attempts the fixed model-list request with the fresh bundle. It returns an empty `modelIds` array plus a sanitized `modelListError` on failure; this error never rolls back or removes the provider.

- [ ] **Step 6: Add Worker REST routes and model reconciliation**

Mount `codexRoutes(ctx)` under `/api`. Each handler obtains `c.env.USER_HUB.getByName(String(DEFAULT_USER_ID))`. After a new-provider RPC completion, load the provider DTO and call `reconcileProviderModels(ctx, providerId, ids, { enableNew: true })`; reconnect and later manual refresh do not enable newly discovered models automatically. Catch model-sync errors into `model_sync_warning` without undoing credentials.

Move kind-aware DTO reads into `provider-read.ts`. `GET /providers` and OAuth completion both use it. The reader joins OAuth rows only for DTO projection and returns `status`, `account_email`, `access_expires_at`, and `last_error`; it never selects decrypted data and never returns `account_id` or `encrypted_bundle`. Keep the synchronous custom-provider projection helper for the custom write transaction result.

Expose:

```text
POST   /api/codex/oauth/start
POST   /api/codex/oauth/:flowId/poll
DELETE /api/codex/oauth/:flowId
POST   /api/providers/:id/codex/reconnect
```

- [ ] **Step 7: Run OAuth and regression tests**

Run: `pnpm vitest run --project worker test/worker/codex-oauth.test.ts test/worker/hub-do.test.ts test/worker/api.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the OAuth flow**

```bash
git add src/server/plugins/codex src/server/plugins/api/codex.ts src/server/plugins/api/provider-read.ts src/server/plugins/api/providers.ts src/server/plugins/api/provider-write.ts src/server/plugins/api/index.ts src/server/app.ts src/server/cordis.d.ts src/server/index.ts src/shared/api.ts test/worker/codex-oauth.test.ts test/worker/hub-do.test.ts
git commit -m "feat(codex): add device authorization flow"
```

---

### Task 6: Add Codex Model Discovery and Responses Transport

**Files:**
- Create: `src/server/plugins/llm/providers/codex.ts`
- Modify: `src/server/plugins/llm/index.ts`
- Modify: `src/server/plugins/api/providers.ts`
- Modify: `src/server/plugins/codex/index.ts`
- Create: `test/unit/llm-codex.test.ts`
- Modify: `test/worker/llm.test.ts`
- Modify: `test/worker/hub-generation.test.ts`
- Modify: `test/worker/codex-oauth.test.ts`

**Interfaces:**
- Consumes: `Codex.getValidCredentials(providerId, forceRefresh?)` and `Codex.listModels(providerId)`.
- Produces: `LlmProviderAdapter` and `Llm.registerProvider(kind, adapter)`.
- Produces: `normalizeCodexResponsesBody(body: string): string`, `createCodexModel(codex: Codex, provider: ProviderRow, providerInterface: ProviderInterfaceRow, model: ModelRow, trace?: LlmRequestTrace): Promise<LanguageModel>`, and `UserHub.listCodexModels(providerId: number): Promise<string[]>`.

- [ ] **Step 1: Write failing transport contract tests**

Assert request normalization and headers using synthetic tokens:

```ts
const normalized = JSON.parse(normalizeCodexResponsesBody(JSON.stringify({
  model: 'gpt-test',
  input: [],
  previous_response_id: 'remote-state',
  store: true,
})))
expect(normalized).toMatchObject({
  model: 'gpt-test',
  input: [],
  instructions: '',
  store: false,
  include: ['reasoning.encrypted_content'],
})
expect(normalized).not.toHaveProperty('previous_response_id')
```

Also assert bearer auth, `ChatGPT-Account-ID`, fixed Codex URL, originator, one forced-refresh retry on a pre-stream 401, no second retry, and redacted observability.

- [ ] **Step 2: Run transport tests and confirm failure**

Run: `pnpm vitest run --project unit test/unit/llm-codex.test.ts && pnpm vitest run --project worker test/worker/llm.test.ts`

Expected: FAIL because provider-kind dispatch and the Codex adapter do not exist.

- [ ] **Step 3: Add provider-kind dispatch to Llm**

Define:

```ts
export interface LlmProviderAdapter {
  createModel(provider: ProviderRow, providerInterface: ProviderInterfaceRow, model: ModelRow, trace?: LlmRequestTrace): Promise<LanguageModel>
}

registerProvider(kind: ProviderKind, adapter: LlmProviderAdapter): () => void
```

`createModel` first checks the kind adapter. Only when none is registered does it decrypt `api_key` and use the existing protocol adapter. Codex `native_files` is always false, so Files dispatch remains unchanged.

- [ ] **Step 4: Implement refresh single-flight**

In the Codex service, use one promise per provider:

```ts
async getValidCredentials(providerId: number, forceRefresh = false): Promise<CodexCredentialSnapshot> {
  const current = await this.credentials.read(providerId)
  if (!current || current.status !== 'connected') throw new CodexReconnectRequiredError(providerId)
  if (!forceRefresh && current.bundle.expiresAt > Date.now() + CODEX_REFRESH_SKEW_MS) return current
  return this.refreshOnce(current)
}
```

`refreshOnce` re-reads before calling OpenAI, stores with CAS, reloads after a stale CAS, and conditionally marks only permanent failures as reconnect-required.

- [ ] **Step 5: Implement the dedicated AI SDK adapter**

Create an Open Responses provider through the existing file-aware factory with fixed settings:

```ts
return createFileAwareResponsesModel({
  name: RESPONSES_PROVIDER_NAME,
  url: `${CODEX_API_BASE_URL}/responses`,
  apiKey: credentials.bundle.accessToken,
  fetch: codexFetch,
}, model.model_id)
```

The fetch wrapper parses string JSON bodies, forces `store: false`, adds encrypted reasoning inclusion, supplies `instructions: ''`, and removes `previous_response_id`, `generate`, `prompt_cache_retention`, `safety_identifier`, and `stream_options`. It retries exactly once after a 401 by forcing refresh and rebuilding authorization headers.

Keep `RESPONSES_PROVIDER_NAME = 'responses'`. The existing `buildProviderOptions`, file-reference wrapper, and raw-chunk inclusion remain the authority for Responses metadata and reasoning. Codex uses inline images, so the file-reference wrapper receives no native provider references in this MVP.

- [ ] **Step 6: Route Codex model listing through the Durable Object**

For `codex-oauth`, `/providers/:id/fetch-models` calls `stub.listCodexModels(id)` and then `reconcileProviderModels`. Custom providers continue through `listRemoteModels` unchanged. The OAuth completion path uses the same method.

- [ ] **Step 7: Add generation integration coverage**

Mock a Codex SSE response containing text and reasoning events. Assert the stored assistant message retains `providerOptions.responses.itemId`, encrypted reasoning metadata, full reasoning text when present, and ordinary tool call IDs. Add an inline image case asserting the request contains `input_image.image_url` with data bytes and never calls a Files endpoint.

- [ ] **Step 8: Run transport and generation tests**

Run: `pnpm vitest run --project unit test/unit/llm-codex.test.ts test/unit/llm-messages.test.ts test/unit/llm-accumulator.test.ts && pnpm vitest run --project worker test/worker/llm.test.ts test/worker/hub-generation.test.ts test/worker/codex-oauth.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the transport**

```bash
git add src/server/plugins/llm src/server/plugins/codex/index.ts src/server/plugins/api/providers.ts test/unit/llm-codex.test.ts test/unit/llm-accumulator.test.ts test/worker/llm.test.ts test/worker/hub-generation.test.ts test/worker/codex-oauth.test.ts
git commit -m "feat(codex): add Responses transport"
```

---

### Task 7: Enforce Codex Provider Writes, Disconnect, Revoke, and Delete

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/server/plugins/api/provider-write.ts`
- Modify: `src/server/plugins/api/providers.ts`
- Modify: `src/server/plugins/api/codex.ts`
- Modify: `src/server/plugins/codex/index.ts`
- Modify: `src/server/plugins/codex/credentials.ts`
- Modify: `test/worker/api.test.ts`
- Modify: `test/worker/codex-oauth.test.ts`

**Interfaces:**
- Produces: `CodexProviderUpdateSchema = { name: string; enabled?: boolean }`.
- Produces: `UserHub.disconnectCodexProvider` and `UserHub.prepareCodexDelete`.
- Produces: `POST /api/providers/:id/codex/disconnect`.
- Preserves: `ProviderWriteInputSchema` for custom provider creation and updates.
- Produces: best-effort revoke followed by unconditional local disconnect/delete behavior.

- [ ] **Step 1: Write failing invariant and lifecycle tests**

Cover direct API attempts to set Codex keys, interfaces, endpoints, protocols, or models.dev association. Cover successful name/enabled changes, revoke failure followed by local disconnect, and revoke failure followed by provider deletion:

```ts
const rejected = await request('PUT', `/providers/${provider.id}`, {
  name: 'Hijacked',
  enabled: true,
  interfaces: [{ protocol: 'responses', base_url: 'https://evil.test/v1' }],
})
expect(rejected.status).toBe(400)

const accepted = await request('PUT', `/providers/${provider.id}`, { name: 'Personal Codex', enabled: false })
expect(accepted.status).toBe(200)
expect(await accepted.json()).toMatchObject({ name: 'Personal Codex', enabled: false, kind: 'codex-oauth' })
```

- [ ] **Step 2: Run lifecycle tests and confirm failure**

Run: `pnpm vitest run --project worker test/worker/api.test.ts test/worker/codex-oauth.test.ts`

Expected: FAIL because generic provider writes still expect custom connection fields.

- [ ] **Step 3: Dispatch provider writes by stored kind**

For POST, continue accepting only `ProviderWriteInputSchema` and always create `custom`. For PUT, load the provider first. Parse custom rows with `ProviderWriteInputSchema`; parse Codex rows with:

```ts
export const CodexProviderUpdateSchema = z.strictObject({
  name: z.string().min(1).max(100),
  enabled: z.boolean().optional(),
})
export type CodexProviderUpdate = z.infer<typeof CodexProviderUpdateSchema>
```

Implement `writeCodexProvider(ctx, id, input)` without touching interfaces, OAuth rows, model association, or credential version.

- [ ] **Step 4: Implement revoke and local-clear ordering**

`disconnectCodexProvider` reads and decrypts the current bundle, attempts `client.revoke(refreshToken)`, logs only the status category on failure, and always performs the conditional local disconnect. `prepareCodexDelete` performs the same revoke/clear sequence before the Worker deletes the provider.

Generation that races after local clear must observe `disconnected` and fail before upstream I/O.

- [ ] **Step 5: Run API and credential tests**

Run: `pnpm vitest run --project worker test/worker/api.test.ts test/worker/codex-oauth.test.ts test/worker/codex-credentials.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit lifecycle enforcement**

```bash
git add src/shared/api.ts src/server/plugins/api/provider-write.ts src/server/plugins/api/providers.ts src/server/plugins/codex test/worker/api.test.ts test/worker/codex-oauth.test.ts test/worker/codex-credentials.test.ts
git commit -m "feat(codex): enforce managed provider lifecycle"
```

---

### Task 8: Add the Device-Code Creation Experience

**Files:**
- Create: `src/client/components/codex-oauth-dialog.vue`
- Modify: `src/client/components/provider-create-dialog.vue`
- Modify: `src/client/lib/api.ts`
- Modify: `src/client/components/provider-navigation.vue`
- Modify: `test/unit/client-provider-create.test.ts`
- Modify: `test/unit/client-sidebar-rows.test.ts`

**Interfaces:**
- Consumes: OAuth REST schemas from Task 5.
- Produces: `CodexOAuthDialog` events `created(provider)` and `update:open(boolean)`.
- Produces: client API methods `startCodexOAuth`, `pollCodexOAuth`, and `cancelCodexOAuth`.

- [ ] **Step 1: Write failing component tests**

Test behavioral states rather than exact prose:

```ts
document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
await vi.waitFor(() => expect(api.startCodexOAuth).toHaveBeenCalledOnce())
expect(document.querySelector('[data-codex-user-code]')?.textContent).toContain('ABCD-EFGH')
expect(document.querySelector('[data-provider-key]')).toBeNull()
expect(document.querySelector('[data-interface-url]')).toBeNull()
```

Cover success emission, pending poll timing, closing cancellation, expiry, denial, retry after transient failure, and no custom-provider draft mutation.

- [ ] **Step 2: Run the creation tests and confirm failure**

Run: `pnpm vitest run --project unit test/unit/client-provider-create.test.ts test/unit/client-sidebar-rows.test.ts`

Expected: FAIL because the Codex entry and dialog do not exist.

- [ ] **Step 3: Add typed client API calls**

Implement:

```ts
startCodexOAuth: () => request<CodexOAuthStartResponse>('POST', '/api/codex/oauth/start'),
pollCodexOAuth: (flowId: string) => request<CodexOAuthPollResponse>('POST', `/api/codex/oauth/${flowId}/poll`),
cancelCodexOAuth: (flowId: string) => request<void>('DELETE', `/api/codex/oauth/${flowId}`),
```

Parse each JSON response with its shared Zod schema before returning it.

- [ ] **Step 4: Implement the OAuth dialog state machine**

The dialog owns exactly these states:

```ts
type ViewState =
  | { type: 'starting' }
  | { type: 'waiting'; grant: CodexOAuthStartResponse }
  | { type: 'failed'; message: string }
  | { type: 'expired' }
```

Schedule the next client poll from the server-provided `next_poll_at`, not a fixed interval. Clear timers on close and unmount. Closing a waiting flow calls cancel once. On complete, emit the provider and close.

- [ ] **Step 5: Add the dedicated creation entry and provider badges**

Keep catalog/custom creation unchanged. Add a separate `添加 Codex` action with `data-add-codex`. In provider navigation, show the account status for Codex rather than the misleading `无密钥` badge.

- [ ] **Step 6: Run client tests**

Run: `pnpm vitest run --project unit test/unit/client-provider-create.test.ts test/unit/client-sidebar-rows.test.ts test/unit/client-settings.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the creation UI**

```bash
git add src/client/components/codex-oauth-dialog.vue src/client/components/provider-create-dialog.vue src/client/components/provider-navigation.vue src/client/lib/api.ts test/unit/client-provider-create.test.ts test/unit/client-sidebar-rows.test.ts
git commit -m "feat(codex): add device login UI"
```

---

### Task 9: Add Managed Codex Provider Settings

**Files:**
- Modify: `src/client/views/settings-provider-edit.vue`
- Modify: `src/client/lib/provider-settings.ts`
- Modify: `src/client/lib/api.ts`
- Modify: `test/unit/client-provider-editor.test.ts`
- Modify: `test/unit/provider-fixtures.ts`

**Interfaces:**
- Consumes: Codex provider DTO and reconnect/disconnect routes.
- Produces: kind-aware provider drafts and managed credential actions.

- [ ] **Step 1: Write failing managed-settings tests**

Mount the editor with a Codex fixture and assert:

```ts
expect(document.querySelector('#provider-name')).not.toBeNull()
expect(document.querySelector('#provider-enabled')).not.toBeNull()
expect(document.querySelector('[data-provider-key]')).toBeNull()
expect(document.querySelector('[data-provider-default-url]')).toBeNull()
expect(document.querySelector('[data-codex-account]')?.textContent).toContain('me@example.com')
```

Cover connected, reconnect-required, and disconnected states; reconnect success; disconnect with revoke warning; model refresh; name/enabled save; and stale async responses not repainting a newer provider.

- [ ] **Step 2: Run editor tests and confirm failure**

Run: `pnpm vitest run --project unit test/unit/client-provider-editor.test.ts`

Expected: FAIL because the editor renders the generic form for Codex.

- [ ] **Step 3: Make drafts and save schemas kind-aware**

Define a client-only union:

```ts
export type ProviderSettingsDraft =
  | { kind: 'custom'; input: ProviderWriteInput }
  | { kind: 'codex-oauth'; input: CodexProviderUpdate }
```

`providerSettingsDraft` returns the Codex branch with only `name` and `enabled`. The view submits `api.updateCodexProvider` for that branch and keeps the existing custom save path unchanged.

- [ ] **Step 4: Render managed credential controls**

Render `ProviderSettingsForm` only for custom providers. For Codex, render account email, status, expiry, last sanitized error, reconnect, and disconnect. Do not render interface configuration, API key, native Files, or models.dev association. Keep the existing model list, manual model entry, filters, bulk enable/disable, and refresh action.

- [ ] **Step 5: Implement reconnect and disconnect client actions**

Reconnect opens `CodexOAuthDialog` with the current provider ID and reloads providers/models on completion. Disconnect calls the dedicated API, invalidates provider models, reloads the DTO, and leaves the route open. Disable credential actions while provider save, model mutation, or OAuth action is pending.

- [ ] **Step 6: Run client regression tests**

Run: `pnpm vitest run --project unit test/unit/client-provider-editor.test.ts test/unit/client-provider-create.test.ts test/unit/client-settings.test.ts test/unit/client-model-picker.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit managed settings**

```bash
git add src/client/views/settings-provider-edit.vue src/client/lib/provider-settings.ts src/client/lib/api.ts test/unit/client-provider-editor.test.ts test/unit/provider-fixtures.ts
git commit -m "feat(codex): add managed provider settings"
```

---

### Task 10: Complete End-to-End Verification and Documentation

**Files:**
- Modify: `README.md`
- Modify: focused tests from Tasks 1-9 only when verification exposes a product bug.

**Interfaces:**
- Consumes: every preceding task.
- Produces: documented setup and a verified deployable build.

- [ ] **Step 1: Add a regression test for the full mocked path**

In `test/worker/codex-oauth.test.ts`, run start → authorize → provider creation → model sync → generation → forced refresh → disconnect. Assert the terminal database state:

```ts
expect(await env.DB.prepare('SELECT status, encrypted_bundle FROM provider_oauth_credentials WHERE provider_id = ?').bind(providerId).first()).toEqual({
  status: 'disconnected',
  encrypted_bundle: null,
})
expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM models WHERE provider_id = ?').bind(providerId).first()).toMatchObject({ count: 2 })
```

- [ ] **Step 2: Run the focused Codex suite**

Run:

```bash
pnpm vitest run --project unit test/unit/codex-client.test.ts test/unit/llm-codex.test.ts test/unit/client-provider-create.test.ts test/unit/client-provider-editor.test.ts
pnpm vitest run --project worker test/worker/codex-credentials.test.ts test/worker/codex-oauth.test.ts test/worker/llm.test.ts test/worker/hub-generation.test.ts test/worker/api.test.ts
```

Expected: PASS.

- [ ] **Step 3: Update README behavior and deployment notes**

Document:

- Codex is added through device authorization, not the custom-provider form.
- Several distinct accounts may be connected as independent providers.
- The endpoint and protocol are fixed and credentials stay server-side.
- Images are input inline; Files and image generation are not implemented.
- Reconnect-required status needs browser interaction and cron does not reauthorize.
- Real-account acceptance must avoid copying credentials into logs, fixtures, or issue text.

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
git status -sb
```

Expected: typecheck succeeds, all tests pass, the production build succeeds, diff check is clean, and only intended Codex/documentation files are modified.

- [ ] **Step 5: Perform real Worker acceptance with user interaction**

Deploy the branch only after explicit user instruction. In the protected deployment, the user completes the device-code page. Verify one model refresh, one text stream, one reasoning reply, one host-supplied function tool, one inline-image request, reconnect, and disconnect. Inspect redacted logs only for operation names and status categories.

- [ ] **Step 6: Commit documentation and any verified corrections**

```bash
git add README.md
git commit -m "docs: document Codex OAuth providers"
```

- [ ] **Step 7: Push the completed implementation batch**

```bash
git push origin feat/codex-oauth
```
