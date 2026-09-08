# Reasoning and Files Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and replay complete reasoning across compatible APIs and actively expire/delete provider-uploaded files.

**Architecture:** The LLM service resolves a model's effective provider interface before selecting an adapter. Responses language calls use `@ai-sdk/open-responses`; Files remain separate optional clients. File uploads create append-only scoped pointer rows, and a daily indexed cleanup job retries remote deletion without ever reusing expired references.

**Tech Stack:** AI SDK 7, `@ai-sdk/open-responses`, `@ai-sdk/openai-compatible`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google-vertex`, Cloudflare Workers cron, D1, R2, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-provider-catalog-and-interface-design.md`

## Global Constraints

- Execute after `2026-09-07-provider-interfaces-model-catalog.md`.
- The reasoning toggle controls request parameters only; returned reasoning is never filtered.
- Preserve reasoning text, provider metadata, tool-call ordering, false/zero/null settings, and opaque state.
- Supported protocols are exactly `responses`, `chat-completions`, `anthropic`, and `vertex-compatible`.
- `@ai-sdk/openai` is not a language protocol; it remains only for OpenAI-compatible Files API.
- Expired pointers are unusable even when remote deletion fails.
- Remote cleanup must never expose API keys or authorization headers in logs/errors.

---

### Task 1: Open Responses language adapter

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Delete: `src/server/plugins/llm/protocols/openai-responses.ts`
- Create: `src/server/plugins/llm/protocols/responses.ts`
- Rename/Modify: `src/server/plugins/llm/protocols/openai-completions.ts` to `src/server/plugins/llm/protocols/chat-completions.ts`
- Delete: `src/server/plugins/llm/protocols/vertex.ts`
- Modify: `src/server/plugins/llm/index.ts`
- Modify: `src/server/plugins/llm/messages.ts`
- Test: `test/worker/llm.test.ts`
- Test: `test/unit/llm-messages.test.ts`

**Interfaces:**
- Consumes: `ProviderInterfaceRow` and resolved Model metadata from the provider/catalog plan.
- Produces: adapters registered as `responses`, `chat-completions`, `anthropic`, and `vertex-compatible`; `createModel(provider, interface, model, apiKey)`.

- [ ] **Step 1: Write failing adapter tests**

Assert `responses` builds the exact `${baseURL}/responses` URL with `createOpenResponses`, Chat Completions retains `reasoning_content`, native Vertex is absent, and provider options use the selected interface protocol.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run test/worker/llm.test.ts test/unit/llm-messages.test.ts`

Expected: FAIL because old protocol names/adapters remain.

- [ ] **Step 3: Install and implement adapters**

Run: `pnpm add @ai-sdk/open-responses@^2.0.34`

Create the provider with a stable metadata namespace and exact Responses POST URL:

```ts
const base = providerInterface.base_url.replace(/\/+$/, '')
return createOpenResponses({
  name: 'responses',
  url: `${base}/responses`,
  apiKey,
})(model.model_id)
```

Map reasoning effort through the AI SDK top-level reasoning option or the package's provider-native `reasoningEffort`; do not request/synthesize a summary as a replacement for full reasoning. Remove native Vertex registration and rename the compatible Chat adapter/protocol.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm vitest run test/worker/llm.test.ts test/unit/llm-messages.test.ts && pnpm typecheck`

Expected: PASS.

```bash
git add package.json pnpm-lock.yaml src/server/plugins/llm test/worker/llm.test.ts test/unit/llm-messages.test.ts test/unit/__snapshots__/llm-messages.test.ts.snap
git commit -m "fix(llm): use open responses for reasoning models"
```

### Task 2: Complete reasoning stream and replay contract

**Files:**
- Modify: `src/server/plugins/llm/accumulator.ts`
- Modify: `src/server/plugins/llm/messages.ts`
- Modify: `src/server/plugins/hub/generation.ts`
- Modify: `src/shared/parts.ts`
- Test: `test/unit/llm-accumulator.test.ts`
- Test: `test/unit/llm-messages.test.ts`
- Modify: `test/worker/hub-generation.test.ts`
- Create: `test/fixtures/deepseek-responses-stream.ts`

**Interfaces:**
- Produces: lossless `Part[]` ordering and metadata round-trip from AI SDK stream to D1 and back to model messages.
- Consumes: adapters from Task 1.

- [ ] **Step 1: Add failing DeepSeek stream tests**

Use a sanitized fixture containing `response.reasoning_text.delta`, reasoning completion metadata, a function call, output text, and usage. Assert accumulated parts retain reasoning text and original sequence.

```ts
expect(saved.parts.map(part => part.type)).toEqual(['reasoning', 'tool_call', 'text'])
expect(saved.parts[0]).toMatchObject({ type: 'reasoning', text: 'complete reasoning' })
```

- [ ] **Step 2: Add failing second-turn replay tests**

Build the next request from persisted parts and assert the Responses input order and Chat `reasoning_content`. Repeat with `reasoning_enabled: false` and assert historical reasoning is still present while the new request effort is `none` only when supported.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm vitest run test/unit/llm-accumulator.test.ts test/unit/llm-messages.test.ts test/worker/hub-generation.test.ts`

Expected: FAIL wherever the old OpenAI-only metadata assumptions lose or reorder reasoning.

- [ ] **Step 4: Implement lossless handling**

Keep stream IDs mapped to their original parts, store provider metadata on start/delta/end, and preserve the content order passed by AI SDK. `buildModelMessages` must emit stored reasoning independent of the current toggle; target adapters consume only their own provider metadata namespace.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run test/unit/llm-accumulator.test.ts test/unit/llm-messages.test.ts test/worker/hub-generation.test.ts`

Expected: PASS.

```bash
git add src/server/plugins/llm/accumulator.ts src/server/plugins/llm/messages.ts src/server/plugins/hub/generation.ts src/shared/parts.ts test/unit/llm-accumulator.test.ts test/unit/llm-messages.test.ts test/worker/hub-generation.test.ts test/fixtures/deepseek-responses-stream.ts
git commit -m "fix(reasoning): preserve complete model reasoning"
```

### Task 3: Protocol-specific Files clients

**Files:**
- Create: `src/server/plugins/llm/files/openai.ts`
- Create: `src/server/plugins/llm/files/anthropic.ts`
- Create: `src/server/plugins/llm/files/types.ts`
- Modify: `src/server/plugins/llm/index.ts`
- Test: `test/unit/llm-files.test.ts`
- Modify: `test/worker/llm.test.ts`

**Interfaces:**
- Produces: `createFiles(provider, interface): Promise<ScopedFilesClient>` where the result contains `family`, normalized `baseURL`, and `FilesV4`; Anthropic client implements `deleteFile`.
- Consumes: provider shared key and selected interface.

- [ ] **Step 1: Write failing Files client tests**

Mock fetch and assert both OpenAI protocols share family/base URL, Vertex has no client, Anthropic upload FormData contains `expires_in_seconds=604800`, Anthropic DELETE targets `/files/{encodedId}`, and authorization values never appear in thrown messages.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run test/unit/llm-files.test.ts test/worker/llm.test.ts`

Expected: FAIL because Anthropic `FilesV4` lacks expiry/delete and file clients are provider-scoped.

- [ ] **Step 3: Implement OpenAI and Anthropic clients**

Use `createOpenAI({ baseURL, apiKey }).files()` for both OpenAI formats. Wrap only the Anthropic Files client fetch: append the expiry field to POST FormData and implement the optional delete operation with the same validated base URL and headers required by Anthropic Files.

```ts
export interface ScopedFilesClient {
  family: 'openai' | 'anthropic'
  baseURL: string
  credentialVersion: number
  files: FilesV4
}
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm vitest run test/unit/llm-files.test.ts test/worker/llm.test.ts`

Expected: PASS.

```bash
git add src/server/plugins/llm/files src/server/plugins/llm/index.ts test/unit/llm-files.test.ts test/worker/llm.test.ts
git commit -m "feat(files): add scoped provider file clients"
```

### Task 4: Append-only pointer reuse and upload

**Files:**
- Modify: `src/server/plugins/hub/sessions.ts`
- Modify: `src/server/plugins/hub/attachment-transport.ts`
- Modify: `src/server/plugins/hub/generation.ts`
- Test: `test/worker/hub-generation.test.ts`
- Modify: `test/worker/db.test.ts`

**Interfaces:**
- Produces: `findReusableProviderFile(db, scope, attachmentId, now)` and `insertProviderFile(db, row)`; no pointer upsert.
- Consumes: append-only file schema and `ScopedFilesClient`.

- [ ] **Step 1: Write failing pointer tests**

Cover sharing between Responses/Chat with equal OpenAI scopes, isolation by family/base URL/credential version, latest-unexpired selection, expired refusal, new upload preserving old rows, and missing native Files inline behavior.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run test/worker/db.test.ts test/worker/hub-generation.test.ts`

Expected: FAIL because current code keys/upserts by provider only.

- [ ] **Step 3: Implement scoped append-only transport**

Resolve the model's effective interface before attachment transport. Query the indexed scope for the latest `expires_at > now` row. If absent, upload once per turn/client, insert a new row with `cleanup_after = expires_at`, and leave every expired row intact for cron retry.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm vitest run test/worker/db.test.ts test/worker/hub-generation.test.ts`

Expected: PASS.

```bash
git add src/server/plugins/hub/sessions.ts src/server/plugins/hub/attachment-transport.ts src/server/plugins/hub/generation.ts test/worker/hub-generation.test.ts test/worker/db.test.ts
git commit -m "feat(files): scope and retain provider pointers"
```

### Task 5: Remote deletion and retrying cron cleanup

**Files:**
- Create: `src/server/plugins/files-cleanup.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/plugins/api/providers.ts`
- Modify: `src/server/plugins/hub/sessions.ts`
- Modify: `test/worker/app.test.ts`
- Modify: `test/worker/api.test.ts`
- Create: `test/worker/files-cleanup.test.ts`

**Interfaces:**
- Produces: `cleanupExpiredProviderFiles(ctx, now, options): Promise<FileCleanupResult>`; best-effort pre-change cleanup for provider/interface/key/base URL changes.
- Consumes: indexed due pointers and `ScopedFilesClient.deleteFile`.

- [ ] **Step 1: Write failing cleanup tests**

Cover delete success, 404/410 as success, network/429/5xx/401/403 retry, unrecoverable 4xx local removal, missing provider/interface behavior, pagination, concurrency bound, run limit, error redaction, and catalog-refresh independence.

```ts
expect(await duePointers()).toHaveLength(1)
expect((await duePointers())[0]!.cleanup_attempts).toBe(1)
expect((await duePointers())[0]!.cleanup_after).toBeGreaterThan(now)
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run test/worker/files-cleanup.test.ts test/worker/app.test.ts test/worker/api.test.ts`

Expected: FAIL because current cron deletes D1 rows without remote calls.

- [ ] **Step 3: Implement cleanup classification**

Query due rows using `cleanup_after`, group by file scope/client, and process with bounded concurrency. Delete D1 rows only for remote success/already-missing/unrecoverable reference. Retry transient/auth failures on the next daily window and store a sanitized summary.

- [ ] **Step 4: Wire scheduled and configuration cleanup**

Run catalog refresh and file cleanup with independent error capture. Before destructive provider/interface/key/base URL changes, attempt the affected remote deletes while old credentials/config remain available; never retain old credentials after the configuration operation completes.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run test/worker/files-cleanup.test.ts test/worker/app.test.ts test/worker/api.test.ts`

Expected: PASS.

```bash
git add src/server/plugins/files-cleanup.ts src/server/index.ts src/server/plugins/api/providers.ts src/server/plugins/hub/sessions.ts test/worker/files-cleanup.test.ts test/worker/app.test.ts test/worker/api.test.ts
git commit -m "feat(files): delete expired remote uploads"
```

### Task 6: End-to-end verification

**Files:**
- No planned production edits; failures return to the task that owns the affected file.
- Test: reasoning/files suites from this plan

**Interfaces:**
- Consumes: completed reasoning/files subsystem.
- Produces: verified feature branch ready for final review.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run \
  test/unit/llm-files.test.ts \
  test/unit/llm-accumulator.test.ts \
  test/unit/llm-messages.test.ts \
  test/worker/llm.test.ts \
  test/worker/hub-generation.test.ts \
  test/worker/files-cleanup.test.ts \
  test/worker/app.test.ts \
  test/worker/api.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: all tests/typechecks pass; build may retain only the pre-existing bundle-size advisory and dependency sourcemap warnings.

- [ ] **Step 3: Run opt-in live DeepSeek probe**

Load `.env` without printing it and run the repository's sanitized probe against DeepSeek Responses. Assert non-zero reasoning characters, second-turn replay success, and no secret/reasoning body output. This probe remains outside default CI.

- [ ] **Step 4: Verify scheduled cleanup locally**

Seed expired OpenAI and Anthropic pointers against mocked fetch, invoke the scheduled handler, and confirm remote DELETE attempts plus D1 success/retry states. Never invoke deletion against a real provider account during automated verification.

- [ ] **Step 5: Commit verification fixes if present**

If verification changed production or test files, stage those exact files after reviewing `git diff` and commit:

```bash
git commit -m "fix(llm): address reasoning and file lifecycle findings"
```

If no files changed, do not create an empty commit.
