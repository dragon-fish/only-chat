# Projects, Chat UI, Reasoning, and Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dynamically inherited Projects, pre-send chat settings, complete reasoning round-trips, a Vertex-compatible protocol, generated-image persistence, and provider-scoped temporary file reuse.

**Architecture:** D1 remains the durable source of truth, UserHub remains the sole realtime writer for Projects and chat state, and R2 remains the only image-byte store. Effective chat settings are computed at generation start by a pure resolver. LLM protocols register both model factories and optional Files API factories; attachment/provider references are short-lived D1 metadata keyed independently of sessions and models.

**Tech Stack:** Cloudflare Workers, Durable Objects, D1, R2, Hono, Cordis, Drizzle ORM, Vercel AI SDK 7, Vue 3, Pinia, Vue Router, Reka UI, Pug, Tailwind CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-projects-ui-reasoning-design.md`

## Global Constraints

- Project name is the only required Project setting; prompt, model, parameters, and reasoning settings may all be absent.
- Project settings are dynamically inherited at generation start; never copy inherited values into a session.
- Effective model order is session override, then Project default, then the model supplied by the current send command.
- Project prompt is followed by exactly two newlines and the session prompt; do not trim or rewrite either value.
- Reasoning enabled and reasoning effort are independent; `null` effort means Auto and omitted effort means inherit.
- D1 and WebSocket payloads must never contain image base64, image bytes, or provider temporary URLs.
- Every generated image must be validated, hashed, and persisted to R2 before an image part is broadcast or finalized.
- Provider file references are keyed by `(attachment_id, provider_id)`, not by session or model, and expire after seven days unless the provider reports an earlier expiry.
- `native_files` means the provider supports both its native Files API and automatic expiry; custom providers default it to false.
- The default attachment fallback remains inline bytes. Signed/public URLs are out of scope because the deployment is behind Cloudflare Access.
- Do not infer advanced model capabilities from model names.
- Preserve the existing uncommitted `src/client/typed-router.d.ts`; do not stage, overwrite, or revert it.
- Run focused tests during tasks. Do not run the full test suite unless the user asks to merge or push the completed implementation.

## File Structure

- `src/shared/models.ts`, `api.ts`, `ws.ts`, `parts.ts`: wire schemas for Projects, provider capability, reasoning states, and metadata-bearing parts.
- `src/server/db/schema.ts` plus migration `0001_projects-media.sql`: Projects, session membership, provider file references, and provider file capability.
- `src/server/plugins/hub/effective-config.ts`: pure Project/session inheritance resolver.
- `src/server/plugins/hub/projects.ts`: Project D1 operations used by UserHub and REST.
- `src/server/plugins/hub/generation.ts`: generation orchestration only; delegates attachment transport and generated-image persistence.
- `src/server/plugins/hub/attachment-transport.ts`: provider-reference lookup/upload and inline fallback.
- `src/server/plugins/hub/generated-images.ts`: generated-file validation, hashing, R2 persistence, and image-part creation.
- `src/server/plugins/llm/index.ts`: protocol adapter registry for language models and optional Files APIs.
- `src/server/plugins/llm/protocols/vertex-compatible.ts`: Vertex-compatible Base URL + Bearer API-key adapter.
- `src/client/components/project-tree.vue`: Project/chat sidebar tree and move/create/delete actions.
- `src/client/components/session-settings.vue`: pre-send and existing-session overrides.
- `src/client/components/reasoning-slider.vue`: model-aware discrete reasoning selector.
- `src/client/views/project-settings.vue`: Project editor.

---

### Task 1: Extend Shared Contracts and D1 Schema

**Files:**
- Modify: `src/shared/models.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/shared/ws.ts`
- Modify: `src/shared/parts.ts`
- Modify: `src/server/db/schema.ts`
- Create: `migrations/0001_projects-media.sql`
- Modify: `migrations/meta/_journal.json`
- Create: `migrations/meta/0001_snapshot.json`
- Test: `test/unit/shared-models.test.ts`
- Test: `test/unit/shared-parts.test.ts`
- Test: `test/unit/shared-ws.test.ts`
- Test: `test/worker/db.test.ts`

**Interfaces:**
- Produces: `Project`, `ProjectInput`, expanded `SessionParams`, expanded `ModelCapabilities`, protocol `vertex-compatible`, Project commands/events, `projects`, and `attachmentProviderFiles` tables.
- Consumes: existing Zod schemas and Drizzle conventions.

- [ ] **Step 1: Write failing schema tests**

Add cases that parse the new protocol, Auto reasoning, metadata on text/tool calls, optional Project fields, and provider file isolation:

```ts
expect(ProtocolSchema.parse('vertex-compatible')).toBe('vertex-compatible')
expect(SessionParamsSchema.parse({ reasoning_enabled: true, reasoning_effort: null }))
  .toEqual({ reasoning_enabled: true, reasoning_effort: null })
expect(ModelCapabilitiesSchema.parse({ image_output: true, reasoning_efforts: ['low', 'xhigh'] }))
  .toEqual({ image_output: true, reasoning_efforts: ['low', 'xhigh'] })
expect(ProjectSchema.parse({
  id: 1, user_id: 1, name: 'Design', system_prompt: null,
  provider_id: null, model_id: null, params: null,
  created_at: 1, updated_at: 1,
}).name).toBe('Design')
expect(TextPartSchema.parse({ type: 'text', text: 'ok', providerOptions: { google: { thoughtSignature: 'sig' } } }))
  .toHaveProperty('providerOptions')
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
pnpm vitest run test/unit/shared-models.test.ts test/unit/shared-parts.test.ts test/unit/shared-ws.test.ts test/worker/db.test.ts
```

Expected: failures for missing Project schemas, `vertex-compatible`, expanded reasoning values, metadata fields, and tables.

- [ ] **Step 3: Implement shared schemas**

Use these canonical definitions:

```ts
export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export const ProtocolSchema = z.enum(['openai-completions', 'openai-responses', 'anthropic', 'vertex', 'vertex-compatible'])

export const SessionParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  reasoning_enabled: z.boolean().optional(),
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
})

export const ModelCapabilitiesSchema = z.object({
  vision: z.boolean().optional(), reasoning: z.boolean().optional(), tools: z.boolean().optional(),
  image_output: z.boolean().optional(), reasoning_can_disable: z.boolean().optional(),
  reasoning_efforts: z.array(ReasoningEffortSchema).optional(),
})

export const ProjectSchema = z.object({
  id: z.number().int(), user_id: z.number().int(), name: z.string(),
  system_prompt: z.string().nullable(), provider_id: z.number().int().nullable(),
  model_id: z.string().nullable(), params: SessionParamsSchema.nullable(),
  created_at: z.number(), updated_at: z.number(),
})
```

Add `project_id` to `SessionSchema`; add optional `providerOptions` to text and tool-call parts. Add `native_files` to provider input/DTO. Define Project create/update/delete commands and events, and extend `send` with nullable `project_id`, `system_prompt`, and `params` initialization fields.

- [ ] **Step 4: Implement Drizzle tables and migration**

Add:

```ts
export const projects = sqliteTable('projects', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(), system_prompt: text(), provider_id: integer(), model_id: text(),
  params: text({ mode: 'json' }).$type<SessionParams>(),
  created_at: integer().notNull(), updated_at: integer().notNull(),
}, t => [index('projects_user_updated_idx').on(t.user_id, t.updated_at)])

export const attachmentProviderFiles = sqliteTable('attachment_provider_files', {
  id: integer().primaryKey({ autoIncrement: true }),
  attachment_id: integer().notNull().references(() => attachments.id, { onDelete: 'cascade' }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  provider_reference: text({ mode: 'json' }).$type<Record<string, string>>().notNull(),
  expires_at: integer().notNull(), created_at: integer().notNull(),
}, t => [uniqueIndex('attachment_provider_files_uq').on(t.attachment_id, t.provider_id), index('attachment_provider_files_expiry_idx').on(t.expires_at)])
```

Add `providers.native_files` as a non-null boolean defaulting false and `sessions.project_id` as a nullable `ON DELETE SET NULL` reference with `(project_id, updated_at)` index. Generate the migration with:

```powershell
pnpm exec drizzle-kit generate --name projects-media
```

Rename the generated SQL file to `migrations/0001_projects-media.sql` only if Drizzle did not already use that exact name, and keep the journal tag/path consistent.

- [ ] **Step 5: Run tests and commit**

Run the Step 2 command plus `pnpm typecheck`. Expected: PASS.

```powershell
git add src/shared/models.ts src/shared/api.ts src/shared/ws.ts src/shared/parts.ts src/server/db/schema.ts migrations test/unit/shared-models.test.ts test/unit/shared-parts.test.ts test/unit/shared-ws.test.ts test/worker/db.test.ts
git commit -m "feat(schema): add projects and media references"
```

### Task 2: Implement Dynamic Project Inheritance

**Files:**
- Create: `src/server/plugins/hub/effective-config.ts`
- Create: `src/server/plugins/hub/projects.ts`
- Modify: `src/server/plugins/hub/sessions.ts`
- Modify: `src/server/plugins/hub/generation.ts`
- Test: `test/unit/hub-effective-config.test.ts`
- Test: `test/worker/hub-generation.test.ts`

**Interfaces:**
- Produces: `resolveEffectiveConfig(input): EffectiveConfig`, Project repository functions, and session creation with draft overrides.
- Consumes: `ProjectRow`, `SessionRow`, `SessionParams`, and command fallback model.

- [ ] **Step 1: Write inheritance tests**

Cover prompt concatenation without trimming, field-by-field parameter inheritance, explicit Auto, explicit reasoning disable, and model precedence:

```ts
expect(resolveEffectiveConfig({ session, project, fallbackModel: { provider_id: 9, model_id: 'fallback' } })).toEqual({
  systemPrompt: 'project prompt\n\nsession prompt',
  model: { provider_id: 2, model_id: 'session-model', source: 'session' },
  params: { temperature: 0.4, top_p: 0.9, reasoning_enabled: true, reasoning_effort: null },
})
```

Also test absent session model falling through to Project, then fallback, and a blank-but-present prompt remaining byte-identical.

- [ ] **Step 2: Run tests and verify failure**

```powershell
pnpm vitest run test/unit/hub-effective-config.test.ts test/worker/hub-generation.test.ts
```

Expected: missing resolver and old `resolveTarget` precedence.

- [ ] **Step 3: Implement the pure resolver**

Use explicit presence checks rather than truthiness:

```ts
export interface EffectiveConfig {
  systemPrompt: string | null
  model: { provider_id: number; model_id: string; source: 'session' | 'project' | 'command' }
  params: SessionParams
}

export interface ResolveInput {
  session: SessionRow
  project?: ProjectRow
  fallbackModel: { provider_id: number; model_id: string }
}

export function resolveEffectiveConfig({ session, project, fallbackModel }: ResolveInput): EffectiveConfig {
  const prompts = [project?.system_prompt, session.system_prompt].filter((v): v is string => v !== null && v !== undefined)
  const model = session.provider_id !== null && session.model_id !== null
    ? { provider_id: session.provider_id, model_id: session.model_id, source: 'session' as const }
    : project?.provider_id != null && project.model_id != null
      ? { provider_id: project.provider_id, model_id: project.model_id, source: 'project' as const }
      : { ...fallbackModel, source: 'command' as const }
  return { systemPrompt: prompts.length ? prompts.join('\n\n') : null, model, params: { ...(project?.params ?? {}), ...(session.params ?? {}) } }
}
```

- [ ] **Step 4: Refactor generation target resolution**

Extend `createSession` to persist `project_id`, session prompt, nullable model override, and params in the same insert as the first message draft. Load and ownership-check the Project before resolving the model. Pass the immutable `EffectiveConfig` snapshot into context construction and `streamText`; do not reread Project state during an active stream.

Reject deleted/disabled inherited providers or models with `模型不可用（来源：Project）` or `模型不可用（来源：会话）`. Never silently fall through when an explicitly inherited model is invalid.

- [ ] **Step 5: Run tests and commit**

```powershell
pnpm vitest run test/unit/hub-effective-config.test.ts test/worker/hub-generation.test.ts test/worker/hub-sessions.test.ts
pnpm typecheck
git add src/server/plugins/hub/effective-config.ts src/server/plugins/hub/projects.ts src/server/plugins/hub/sessions.ts src/server/plugins/hub/generation.ts test/unit/hub-effective-config.test.ts test/worker/hub-generation.test.ts test/worker/hub-sessions.test.ts
git commit -m "feat(projects): resolve inherited chat settings"
```

### Task 3: Add Project Realtime CRUD and REST Loading

**Files:**
- Modify: `src/server/plugins/hub/index.ts`
- Modify: `src/server/cordis.d.ts`
- Create: `src/server/plugins/api/projects.ts`
- Modify: `src/server/plugins/api/index.ts`
- Modify: `src/client/lib/api.ts`
- Modify: `src/client/stores/sync.ts`
- Test: `test/worker/hub-sessions.test.ts`
- Test: `test/worker/api.test.ts`
- Test: `test/unit/client-sync-store.test.ts`

**Interfaces:**
- Produces: Project commands/events through UserHub, `GET /api/projects`, `api.projects()`, and `sync.projects`.
- Consumes: Task 1 schemas and Task 2 Project repository functions.

- [ ] **Step 1: Write failing ownership and sync tests**

Test create/update/delete, session movement, delete-to-Chats behavior, and client event application:

```ts
store.applyEvent({ type: 'project.created', project })
expect(store.projects.get(project.id)).toEqual(project)
store.applyEvent({ type: 'project.deleted', project_id: project.id })
expect(store.projects.has(project.id)).toBe(false)
expect(store.sessions.get(session.id)?.project_id).toBeNull()
```

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
pnpm vitest run test/worker/hub-sessions.test.ts test/worker/api.test.ts test/unit/client-sync-store.test.ts
```

- [ ] **Step 3: Implement UserHub commands**

Add `project.create`, `project.update`, and `project.delete` dispatch cases. All writes must filter by `DEFAULT_USER_ID`, write D1 first, then broadcast. On delete, fetch affected sessions before deleting, broadcast `project.deleted`, then broadcast each returned session with `project_id: null`.

Extend `session.update` to accept `project_id`; verify the target Project belongs to the current user before moving the session.

- [ ] **Step 4: Implement REST loading and Pinia state**

Add only the read endpoint:

```ts
r.get('/projects', async c => c.json(await listProjects(ctx.db.orm, DEFAULT_USER_ID)))
```

Load Projects during app boot, keep a reactive `Map<number, Project>`, and expose `projectList` ordered by `updated_at`. Apply Project events without optimistic deletion.

- [ ] **Step 5: Run tests and commit**

Run the Step 2 command and `pnpm typecheck`. Expected: PASS.

```powershell
git add src/server/plugins/hub/index.ts src/server/cordis.d.ts src/server/plugins/api/projects.ts src/server/plugins/api/index.ts src/client/lib/api.ts src/client/stores/sync.ts test/worker/hub-sessions.test.ts test/worker/api.test.ts test/unit/client-sync-store.test.ts
git commit -m "feat(projects): add realtime project management"
```

### Task 4: Complete Reasoning and Provider-Metadata Round Trips

**Files:**
- Modify: `src/server/plugins/llm/accumulator.ts`
- Modify: `src/server/plugins/llm/messages.ts`
- Modify: `src/server/plugins/hub/generation.ts`
- Test: `test/unit/llm-accumulator.test.ts`
- Test: `test/unit/llm-messages.test.ts`
- Test: `test/unit/__snapshots__/llm-messages.test.ts.snap`
- Test: `test/worker/hub-generation.test.ts`

**Interfaces:**
- Produces: metadata-preserving text/reasoning/tool-call parts and `buildProviderOptions` with independent reasoning enabled/effort semantics.
- Consumes: expanded Task 1 schemas and effective params from Task 2.

- [ ] **Step 1: Replace old compatibility expectations with failing round-trip tests**

Add tests for:

```ts
// OpenAI-compatible reasoning is replayed instead of dropped.
expect(assistant.content).toContainEqual({ type: 'reasoning', text: 'analysis' })
// Metadata survives on text and tool calls.
expect(assistant.content[0]).toMatchObject({ providerOptions: { google: { thoughtSignature: 'sig' } } })
// Auto enables reasoning but omits effort.
expect(buildProviderOptions('openai-responses', { reasoning_enabled: true, reasoning_effort: null }, caps))
  .toEqual({ openai: { store: false, reasoningSummary: 'auto' } })
```

Cover OpenAI encrypted reasoning, Anthropic signatures/redacted data, OpenAI-compatible `reasoning_content`, and Gemini thought signatures after JSON round-trip.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
pnpm vitest run test/unit/llm-accumulator.test.ts test/unit/llm-messages.test.ts test/worker/hub-generation.test.ts
```

- [ ] **Step 3: Preserve metadata in accumulator and message builder**

Extend `PartAccumulator` so the last non-null `providerMetadata` wins for text, reasoning, and tool-call parts. Remove the OpenAI-compatible branch that drops reasoning. When rebuilding assistant content, attach each stored part's `providerOptions` without parsing or rewriting it.

- [ ] **Step 4: Implement reasoning option mapping**

Compute `enabled = caps.reasoning && params?.reasoning_enabled !== false`; Auto means enabled with no effort. Map:

```ts
openai: { store: false, ...(enabled ? { reasoningSummary: 'auto', ...(effort ? { reasoningEffort: effort } : {}) } : caps.reasoning_can_disable ? { reasoningEffort: 'none' } : {}) }
compat: enabled && effort ? { reasoningEffort: effort } : {}
anthropic: enabled ? { thinking: { type: 'adaptive', display: 'summarized' }, ...(effort ? { effort } : {}) } : { thinking: { type: 'disabled' } }
googleVertex: enabled ? { thinkingConfig: { includeThoughts: true, ...(effort ? { thinkingLevel: effort } : {}) } } : caps.reasoning_can_disable ? { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } : {}
```

Only send an explicit disable value when `reasoning_can_disable` is true. Otherwise omit the protocol field.

- [ ] **Step 5: Run tests and commit**

Run the Step 2 command and `pnpm typecheck`. Expected: PASS.

```powershell
git add src/shared/parts.ts src/server/plugins/llm/accumulator.ts src/server/plugins/llm/messages.ts src/server/plugins/hub/generation.ts test/unit/llm-accumulator.test.ts test/unit/llm-messages.test.ts test/unit/__snapshots__/llm-messages.test.ts.snap test/worker/hub-generation.test.ts
git commit -m "fix(reasoning): preserve provider round trips"
```

### Task 5: Add the Vertex-Compatible Protocol and Provider Capability UI

**Files:**
- Create: `src/server/plugins/llm/protocols/vertex-compatible.ts`
- Modify: `src/server/plugins/llm/index.ts`
- Modify: `src/server/plugins/llm/presets.ts`
- Modify: `src/server/plugins/llm/list-models.ts`
- Modify: `src/server/plugins/api/providers.ts`
- Modify: `src/client/views/settings-provider-edit.vue`
- Modify: `src/client/views/settings-providers.vue`
- Test: `test/worker/llm.test.ts`
- Test: `test/worker/api.test.ts`
- Test: `test/unit/llm-list-models.test.ts`

**Interfaces:**
- Produces: protocol `vertex-compatible`, Bearer-authenticated Vertex-compatible URL construction, and persisted `native_files` configuration.
- Consumes: `createGoogleVertex` from the installed `@ai-sdk/google-vertex/edge` version.

- [ ] **Step 1: Write failing protocol request tests**

Use a captured fetch to assert:

```ts
expect(request.url).toBe('https://zenmux.ai/api/vertex-ai/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent')
expect(request.headers.get('authorization')).toBe('Bearer test-key')
expect(request.headers.has('x-goog-api-key')).toBe(false)
```

Test malformed model IDs without `/`, model IDs containing additional `/`, trailing Base URL slashes, and provider DTO round-trip of `native_files`.

- [ ] **Step 2: Run tests and verify failure**

```powershell
pnpm vitest run test/worker/llm.test.ts test/worker/api.test.ts test/unit/llm-list-models.test.ts
```

- [ ] **Step 3: Implement `vertex-compatible.ts`**

Split only the first slash:

```ts
export function splitVertexCompatibleModelId(id: string): { publisher: string; model: string } {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) throw new Error('Google model id must be publisher/model')
  return { publisher: id.slice(0, slash), model: id.slice(slash + 1) }
}
```

Create a custom fetch that receives the SDK-added headers, deletes `x-goog-api-key`, sets `Authorization: Bearer ${apiKey}`, and forwards the request. Instantiate `createGoogleVertex` with `apiKey`, `baseURL: ${trimmedBase}/v1/publishers/${publisher}`, and that fetch; return the language model for the remainder model ID.

- [ ] **Step 4: Update provider settings UI and persistence**

Add `Google Vertex 兼容` to the protocol select. For `vertex-compatible`, show only Base URL and API Key. For `vertex`, show service-account JSON, Project, and Location. Add the provider-level switch:

```pug
.flex.items-start.gap-2
  Switch(:model-value="form.native_files" @update:model-value="form.native_files = $event")
  div
    Label 支持原生文件转储（Files API）
    p.text-xs.text-muted-foreground 文件临时上传到当前供应商并自动过期；兼容端点未实现 /files 时请勿开启。
```

Persist it as a real provider column. Set OpenAI preset true and custom providers false. When protocol, Base URL, or API key changes, delete that provider's local attachment references in the same API request after the provider update succeeds.

- [ ] **Step 5: Run tests and commit**

Run the Step 2 command and `pnpm typecheck`. Expected: PASS.

```powershell
git add src/server/plugins/llm/protocols/vertex-compatible.ts src/server/plugins/llm/index.ts src/server/plugins/llm/presets.ts src/server/plugins/llm/list-models.ts src/server/plugins/api/providers.ts src/client/views/settings-provider-edit.vue src/client/views/settings-providers.vue test/worker/llm.test.ts test/worker/api.test.ts test/unit/llm-list-models.test.ts
git commit -m "feat(vertex): add compatible provider"
```

### Task 6: Reuse Expiring Provider Files

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/server/plugins/llm/index.ts`
- Modify: `src/server/plugins/llm/protocols/openai-responses.ts`
- Create: `src/server/plugins/hub/attachment-transport.ts`
- Modify: `src/server/plugins/hub/sessions.ts`
- Modify: `src/server/plugins/hub/generation.ts`
- Modify: `src/server/index.ts`
- Modify: `wrangler.jsonc`
- Test: `test/worker/hub-generation.test.ts`
- Test: `test/worker/app.test.ts`
- Test: `test/unit/llm-messages.test.ts`

**Interfaces:**
- Produces: `Llm.createFiles(provider)`, `resolveAttachmentInputs(...)`, and `cleanupExpiredProviderFiles(db, now)`.
- Consumes: AI SDK `uploadFile`, provider `files()` support, R2 attachment bytes, and Task 1 reference rows.

- [ ] **Step 1: Write failing A → B → A and expiry tests**

Assert that one attachment uploaded through provider A, then B, then A creates exactly two remote uploads and reuses A's first reference. Add an expired-A case that performs a third upload. Assert upload options contain:

```ts
providerOptions: { openai: { purpose: 'user_data', expiresAfter: 604800 } }
```

Verify `native_files: false` never calls `/files`, and auth/429/500 upload errors surface rather than silently becoming inline input.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
pnpm vitest run test/worker/hub-generation.test.ts test/worker/app.test.ts test/unit/llm-messages.test.ts
```

- [ ] **Step 3: Extend the protocol registry with optional Files APIs**

Make the provider interface a direct dependency before importing its types:

```powershell
pnpm add @ai-sdk/provider@^4.0.10
```

Replace the bare factory with:

```ts
export interface LlmProtocolAdapter {
  createModel(provider: ProviderRow, model: ModelRow, apiKey: string): LanguageModel
  createFiles?: (provider: ProviderRow, apiKey: string) => FilesV4
}
```

For `openai-responses`, instantiate `createOpenAI({ baseURL, apiKey })`; use `provider.responses(modelId)` for language generation and `provider.files()` for uploads. `Llm.createFiles` must reject providers whose `native_files` is false or whose adapter has no file factory.

- [ ] **Step 4: Implement attachment transport and scheduled pointer cleanup**

`resolveAttachmentInputs` loads each referenced attachment. When native files are enabled, query `(attachment_id, provider_id)` and reuse only if `expires_at > Date.now()`. Otherwise upload bytes with seven-day expiry and upsert:

```ts
{
  attachment_id: attachment.id,
  provider_id: provider.id,
  provider_reference: result.providerReference,
  expires_at: result.expiresAt?.getTime() ?? Date.now() + 604_800_000,
  created_at: Date.now(),
}
```

Return message file data as `{ type: 'reference', reference }`; inline fallback remains `{ type: 'data', data: bytes }`. Do not add `session_id` or `model_id` to the lookup.

Add `scheduled()` to the Worker handler and a daily cron in `wrangler.jsonc`. The job runs only:

```ts
await db.delete(attachmentProviderFiles).where(lte(attachmentProviderFiles.expires_at, now))
```

It must not call remote DELETE endpoints.

- [ ] **Step 5: Run tests and commit**

Run the Step 2 command and `pnpm typecheck`. Expected: PASS.

```powershell
git add package.json pnpm-lock.yaml src/server/plugins/llm/index.ts src/server/plugins/llm/protocols/openai-responses.ts src/server/plugins/hub/attachment-transport.ts src/server/plugins/hub/sessions.ts src/server/plugins/hub/generation.ts src/server/index.ts wrangler.jsonc test/worker/hub-generation.test.ts test/worker/app.test.ts test/unit/llm-messages.test.ts
git commit -m "feat(files): reuse expiring provider uploads"
```

### Task 7: Persist Generated Images to R2

**Files:**
- Create: `src/server/plugins/hub/generated-images.ts`
- Modify: `src/server/plugins/assets.ts`
- Modify: `src/server/plugins/llm/accumulator.ts`
- Modify: `src/server/plugins/llm/messages.ts`
- Modify: `src/server/plugins/hub/generation.ts`
- Modify: `src/client/components/message-item.vue`
- Test: `test/worker/hub-generation.test.ts`
- Test: `test/worker/api.test.ts`
- Test: `test/unit/llm-accumulator.test.ts`

**Interfaces:**
- Produces: `persistGeneratedImage(hub, file): Promise<ImagePart>` and `PartAccumulator.append(part)`.
- Consumes: AI SDK stream `file` parts, R2 Assets service, attachment table, and SHA-256 dedupe.

- [ ] **Step 1: Write failing generated-image tests**

Cover PNG bytes, base64 output, an HTTPS output fetched by the Worker, duplicate bytes, invalid MIME, oversized output, R2 failure, D1 failure cleanup, and multi-device `message.part` containing only an attachment ID:

```ts
expect(imageEvent.part).toEqual({ type: 'image', attachment_id: expect.any(Number) })
expect(JSON.stringify(imageEvent)).not.toContain('base64')
expect(savedAttachment.origin).toBe('generated')
expect(await env.BUCKET.get(savedAttachment.r2_key)).not.toBeNull()
```

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
pnpm vitest run test/worker/hub-generation.test.ts test/worker/api.test.ts test/unit/llm-accumulator.test.ts
```

- [ ] **Step 3: Implement generated-image persistence**

Accept `image/png`, `image/jpeg`, `image/webp`, and `image/gif`, with the existing 20 MiB limit. If `file.base64` starts with `https://`, fetch it; otherwise use `file.uint8Array`. Validate the response MIME and actual non-empty size before hashing. Use the existing R2 key function and attachment SHA uniqueness. Add `Assets.delete(key)` and delete a newly written R2 object if the D1 insert fails and no deduplicated attachment owns that key.

- [ ] **Step 4: Handle file stream events before broadcasting**

In the generation loop:

```ts
if (part.type === 'file') {
  const imagePart = await persistGeneratedImage(hub, part.file)
  const event = acc.append(imagePart)
  hub.broadcast({ type: 'message.part', message_id: shell.id, ...event })
  await hub.flushInflight(tracked)
  continue
}
```

Add image-output provider options only when `model.capabilities.image_output` is true. Render assistant images through the existing authenticated attachment route. On persistence failure retain accumulated text, set terminal status to error, and never write raw file content to inflight storage or D1.

- [ ] **Step 5: Run tests and commit**

Run the Step 2 command and `pnpm typecheck`. Expected: PASS.

```powershell
git add src/server/plugins/hub/generated-images.ts src/server/plugins/assets.ts src/server/plugins/llm/accumulator.ts src/server/plugins/llm/messages.ts src/server/plugins/hub/generation.ts src/client/components/message-item.vue test/worker/hub-generation.test.ts test/worker/api.test.ts test/unit/llm-accumulator.test.ts
git commit -m "feat(images): persist model output to r2"
```

### Task 8: Build the Project Sidebar and Settings Page

**Files:**
- Create: `src/client/components/project-tree.vue`
- Modify: `src/client/components/session-list.vue`
- Modify: `src/client/components/app-shell.vue`
- Create: `src/client/views/project-settings.vue`
- Create: `src/client/pages/settings/projects/[id].vue`
- Modify: `src/client/stores/sync.ts`
- Test: `test/unit/client-sync-store.test.ts`

**Interfaces:**
- Produces: collapsible Project → chats navigation, unprojected Chats section, session move actions, and Project configuration UI.
- Consumes: Task 3 Project state/events and Task 2 inheritance semantics.

- [ ] **Step 1: Add failing store/view-model tests**

Test sorting Projects, grouping sessions by `project_id`, unprojected Chats, move commands, Project delete moving sessions back, and optional settings remaining null.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
pnpm vitest run test/unit/client-sync-store.test.ts
```

- [ ] **Step 3: Implement the sidebar tree**

Replace the flat list body with `project-tree.vue`. Each Project row toggles its chats and exposes create-chat, edit, and delete actions. A separate Chats section lists `project_id === null`. New chat links carry `?project=<id>` only for Project-created drafts. Session actions send `session.update` with the selected `project_id` or null.

Keep the sidebar header fixed and make only the tree body `min-h-0 flex-1 overflow-y-auto`.

- [ ] **Step 4: Implement Project settings**

Create a route-backed form containing name, prompt, nullable default model, temperature/top-p/max tokens, reasoning enabled, reasoning effort, and delete. Empty selections send null/omitted values rather than copying defaults. Save through `project.update`; navigate back only after the matching `project.updated` event.

- [ ] **Step 5: Run tests and commit**

Run Step 2 and `pnpm typecheck`. Expected: PASS.

```powershell
git add src/client/components/project-tree.vue src/client/components/session-list.vue src/client/components/app-shell.vue src/client/views/project-settings.vue src/client/pages/settings/projects/[id].vue src/client/stores/sync.ts test/unit/client-sync-store.test.ts
git commit -m "feat(projects): add project navigation and settings"
```

### Task 9: Redesign Composer Settings, Reasoning Control, and Wait State

**Files:**
- Create: `src/client/components/session-settings.vue`
- Create: `src/client/components/reasoning-slider.vue`
- Modify: `src/client/components/composer.vue`
- Modify: `src/client/views/chat.vue`
- Modify: `src/client/components/message-item.vue`
- Test: `test/unit/client-sync-store.test.ts`
- Test: `test/worker/hub-generation.test.ts`

**Interfaces:**
- Produces: a new-session draft, per-field inheritance/override controls, discrete reasoning slider, and first-token feedback.
- Consumes: effective settings, Project query parameter, model capabilities, and existing send/session update commands.

- [ ] **Step 1: Write failing state-transition tests**

Cover draft configuration before first send, atomic first-send payload, inherited labels, reset-to-inherit, slider mapping, and wait-state transitions:

```ts
expect(choiceToParams('立即')).toEqual({ reasoning_enabled: false })
expect(choiceToParams('自动')).toEqual({ reasoning_enabled: true, reasoning_effort: null })
expect(choiceToParams('超高')).toEqual({ reasoning_enabled: true, reasoning_effort: 'xhigh' })
```

Verify spinner visibility for empty streaming shell, summary-before-text, text arrival, and empty-summary completion.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
pnpm vitest run test/unit/client-sync-store.test.ts test/worker/hub-generation.test.ts
```

- [ ] **Step 3: Implement draft and session settings**

Move title/system/params controls out of the chat header into a Composer-adjacent `session-settings.vue`. For `sessionId === null`, hold `{ project_id, system_prompt, provider_id, model_id, params }` locally and include it in the first `send`. For an existing session, send `session.update` per saved field. Display each field's source as `继承自 Project` or `会话覆盖`, and clear only that field when the user selects restore inheritance.

- [ ] **Step 4: Implement the slider and wait state**

Build slider stops from model capabilities in this order:

```ts
const ORDER = ['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
```

Show Off only for `reasoning_can_disable`, always show Auto for reasoning models, and show only declared effort values. Use labels `立即、自动、极低、低、中、高、超高、Max、Ultra`.

In `message-item.vue`, show a spinner plus `正在思考…` while an assistant message is streaming with no non-empty text. Show streaming reasoning summary when present; hide the spinner on first text and collapse the summary. Do not synthesize hidden chain-of-thought.

- [ ] **Step 5: Run tests and commit**

Run Step 2 and `pnpm typecheck`. Expected: PASS.

```powershell
git add src/client/components/session-settings.vue src/client/components/reasoning-slider.vue src/client/components/composer.vue src/client/views/chat.vue src/client/components/message-item.vue test/unit/client-sync-store.test.ts test/worker/hub-generation.test.ts
git commit -m "feat(chat): add inherited composer settings"
```

### Task 10: Fix Scrolling, Mobile Sidebar Controls, and Long Provider Pages

**Files:**
- Modify: `src/client/components/app-shell.vue`
- Modify: `src/client/components/session-list.vue`
- Modify: `src/client/views/settings-provider-edit.vue`
- Modify: `src/client/views/settings-providers.vue`
- Modify: `src/client/views/settings-plugins.vue`
- Modify: `src/client/ui/sheet/SheetContent.vue`
- Modify: `src/client/ui/dialog/DialogContent.vue`
- Modify: `src/client/ui/dialog/DialogScrollContent.vue`
- Modify: `src/client/ui/select/SelectContent.vue`
- Modify: `src/client/styles/main.scss`

**Interfaces:**
- Produces: one explicit scroll owner per fixed-height region and non-overlapping mobile close/settings controls.
- Consumes: existing `100dvh` application shell and Reka available-height CSS variables.

- [ ] **Step 1: Record manual regression fixtures**

Create local test data through the existing UI/API: at least 30 models, 10 providers, 10 Projects with 10 chats each, and a model picker taller than the viewport. Record viewport checks at 390×844 and 1280×800 in the task notes before editing.

- [ ] **Step 2: Apply the scroll ownership contract**

Use `h-full min-h-0 overflow-hidden` on route/layout containers and `min-h-0 overflow-y-auto` only on their content body. Provider model tables use a bounded vertical container plus local `overflow-x-auto`. Dialogs and sheets use `max-h-[calc(100dvh-2rem)]`; their middle content scrolls while headers/footers remain fixed. Keep Select content bounded by `--reka-select-content-available-height`.

- [ ] **Step 3: Fix mobile sidebar controls**

Pass `:show-close-button="false"` to the mobile sidebar `SheetContent`. Put Settings and Close buttons in the sidebar's normal flex header, each at least 40×40 CSS pixels, and close the sheet after either navigation action.

- [ ] **Step 4: Verify responsive behavior and typecheck**

Verify the fixtures at both viewports: every last model/provider/project/chat is reachable; the document body does not scroll; Composer stays visible; model picker scrolls; Settings and Close do not overlap.

Run:

```powershell
pnpm typecheck
pnpm build
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```powershell
git add src/client/components/app-shell.vue src/client/components/session-list.vue src/client/views/settings-provider-edit.vue src/client/views/settings-providers.vue src/client/views/settings-plugins.vue src/client/ui/sheet/SheetContent.vue src/client/ui/dialog/DialogContent.vue src/client/ui/dialog/DialogScrollContent.vue src/client/ui/select/SelectContent.vue src/client/styles/main.scss
git commit -m "fix(ui): make long views and mobile sidebar usable"
```

### Task 11: Focused Integration Verification and Documentation

**Files:**
- Modify: `README.md`
- Test: `test/worker/hub-do.test.ts`
- Test: `test/worker/hub-generation.test.ts`
- Test: `test/worker/api.test.ts`
- Test: `test/unit/llm-messages.test.ts`
- Test: `test/unit/client-sync-store.test.ts`

**Interfaces:**
- Produces: verified end-to-end behavior and current configuration documentation.
- Consumes: all prior tasks.

- [ ] **Step 1: Add cross-feature integration cases**

Test a Project chat with inherited prompt/model, Auto reasoning, an uploaded image, A → B → A provider switching, a generated image, reconnect snapshot, and Project deletion. Assert D1 message JSON and DO storage contain only `attachment_id`, while R2 contains the generated bytes and provider references remain provider-scoped.

- [ ] **Step 2: Run the focused integration set**

```powershell
pnpm vitest run test/worker/hub-do.test.ts test/worker/hub-generation.test.ts test/worker/api.test.ts test/worker/hub-sessions.test.ts test/worker/llm.test.ts test/unit/hub-effective-config.test.ts test/unit/llm-accumulator.test.ts test/unit/llm-messages.test.ts test/unit/client-sync-store.test.ts
pnpm typecheck
pnpm build
```

Expected: all selected tests pass; typecheck and build exit 0.

- [ ] **Step 3: Update operational documentation**

Document:

- Google compatible: Base URL, Bearer API key, and `{publisher}/{model}` IDs.
- Native Vertex: service-account JSON, Project, and Location.
- `native_files`: enable only when the endpoint supports Files API plus automatic expiry.
- Seven-day remote expiry and daily local pointer cleanup.
- R2 as the sole durable image-byte store.
- Cloudflare Access exception routes are not required or created by this release.

- [ ] **Step 4: Review the final diff without touching user changes**

```powershell
git status -sb
git diff --check
git diff --stat
git diff -- src/client/typed-router.d.ts
```

Expected: the last command shows only the user's pre-existing generated-router change; it is not staged.

- [ ] **Step 5: Commit the integration/docs batch**

```powershell
git add README.md test/worker/hub-do.test.ts test/worker/hub-generation.test.ts test/worker/api.test.ts test/worker/hub-sessions.test.ts test/worker/llm.test.ts test/unit/hub-effective-config.test.ts test/unit/llm-accumulator.test.ts test/unit/llm-messages.test.ts test/unit/client-sync-store.test.ts
git restore --staged src/client/typed-router.d.ts
git commit -m "test: verify projects reasoning and media flows"
```

Do not push or run the full test suite until the user explicitly asks for the completed implementation to be pushed or merged.
