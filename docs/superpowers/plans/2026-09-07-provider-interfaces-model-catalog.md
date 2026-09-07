# Provider Interfaces and Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-interface providers and a models.dev-backed metadata fallback with indexed D1 model filtering and Lab-aware UI.

**Architecture:** Providers own shared credentials and one or more interface rows. A Worker-side model-catalog service publishes immutable models.dev shards to KV, associates providers by endpoint, resolves metadata for only the models stored in D1, and materializes frequently filtered facts into indexed columns. The REST and Vue layers expose provider/interface editing, catalog status, paginated model queries, overrides, and Lab grouping without treating models.dev as an availability authority.

**Tech Stack:** Cloudflare Workers, KV, D1/SQLite, Drizzle ORM, Hono, Cordis, Zod 4, Vue 3, Pinia, shadcn-vue, Vitest, Cloudflare Vitest integration.

**Spec:** `docs/superpowers/specs/2026-09-07-provider-catalog-and-interface-design.md`

## Global Constraints

- `/models` and manual model creation are the only sources of D1 model membership.
- models.dev is fallback metadata only and never creates, enables, disables, or deletes a model.
- Supported interface protocols are exactly `responses`, `chat-completions`, `anthropic`, and `vertex-compatible`.
- Provider API keys remain encrypted and never leave the server.
- User override values, including false, zero, and explicit null, must beat catalog fallback.
- Common model filters must use indexed materialized fields; verify query plans and D1 rows-read behavior.
- Catalog refresh uses immutable versioned KV shards and keeps the active and previous successful generations.
- The global `models` shard remains one value; provider-specific data is split by provider.
- Do not dynamically install or execute SDK package names from models.dev.

---

### Task 1: Shared provider, interface, and metadata contracts

**Files:**
- Create: `src/shared/model-metadata.ts`
- Modify: `src/shared/models.ts`
- Modify: `src/shared/api.ts`
- Test: `test/unit/shared-models.test.ts`
- Test: `test/unit/model-metadata.test.ts`

**Interfaces:**
- Produces: `InterfaceProtocol = 'responses' | 'chat-completions' | 'anthropic' | 'vertex-compatible'`; `ModelMetadata`, `ModelMetadataOverride`, `CatalogMatches`, `ProviderInterface`, `ModelQuery`, and paginated `ModelPage` schemas. The existing wire DTOs remain until the vertical API/client cutover tasks.
- Consumes: no new project interfaces.

- [ ] **Step 1: Write failing schema tests**

Add cases for the four protocols, nullable inheritance, explicit false/zero/null overrides, nested metadata, provider interfaces, catalog match records, and model query filters.

```ts
expect(InterfaceProtocolSchema.options).toEqual([
  'responses', 'chat-completions', 'anthropic', 'vertex-compatible',
])
expect(ModelMetadataOverrideSchema.parse({ reasoning: false, cost: { input: 0 } }))
  .toEqual({ reasoning: false, cost: { input: 0 } })
expect(ModelQuerySchema.parse({ vision: true, min_context: 262144, limit: 50 }))
  .toMatchObject({ vision: true, min_context: 262144, limit: 50 })
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run test/unit/shared-models.test.ts test/unit/model-metadata.test.ts`

Expected: FAIL because the new contracts do not exist.

- [ ] **Step 3: Implement catalog-aligned schemas**

Define nested Zod schemas for modalities, limits, costs, reasoning options, links, weights, and benchmarks. Keep the application schema explicit; the external parser added later may tolerate unknown upstream fields.

```ts
export const ModelMetadataSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  family: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(ReasoningOptionSchema).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  modalities: ModelModalitiesSchema.optional(),
  limit: ModelLimitSchema.optional(),
  cost: ModelCostSchema.nullable().optional(),
  interleaved: z.union([z.boolean(), z.object({ field: z.string() })]).optional(),
  knowledge: z.string().optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
  open_weights: z.boolean().optional(),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
})
```

Add the new Provider/Model DTOs beside the existing wire contracts so this commit remains type-safe. Add strict API inputs for atomic provider/interface writes and metadata overrides. Task 5 switches the server routes and Task 6 switches the client; Task 7 removes the superseded contracts after both sides use the new types.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/unit/shared-models.test.ts test/unit/model-metadata.test.ts && pnpm typecheck`

Expected: PASS with no production call-site failures because this task is additive.

- [ ] **Step 5: Commit shared contracts**

```bash
git add src/shared/model-metadata.ts src/shared/models.ts src/shared/api.ts test/unit/shared-models.test.ts test/unit/model-metadata.test.ts
git commit -m "feat(models): align metadata contracts with models.dev"
```

### Task 2: D1 schema and migration

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: `migrations/0002_provider-catalog.sql`
- Modify: `migrations/meta/0002_snapshot.json`
- Modify: `migrations/meta/_journal.json`
- Modify: `test/worker/db.test.ts`
- Modify: `test/worker/api.test.ts`

**Interfaces:**
- Consumes: shared contracts from Task 1.
- Produces: `providerInterfaces`, additive provider/model metadata columns, append-only `attachmentProviderFiles`, the `models_fts` search index, and indexes named `models_provider_enabled_sort_idx`, `models_enabled_image_idx`, `models_enabled_reasoning_idx`, and `models_enabled_context_idx`. Legacy columns remain temporarily so the additive commit compiles; Task 7 removes them after server/client cutover.

- [ ] **Step 1: Write failing D1 schema tests**

Add tests that insert a provider with two interfaces, enforce unique `(provider_id, protocol)`, validate default/model interface ownership at repository/API level, store JSON metadata, permit multiple historical file pointers, and query the new B-tree/FTS5 indexes from `sqlite_schema`.

```ts
const indexes = await env.DB.prepare(
  "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'models'",
).all<{ name: string }>()
expect(indexes.results.map(row => row.name)).toContain('models_enabled_context_idx')
```

- [ ] **Step 2: Run worker tests and verify failure**

Run: `pnpm vitest run test/worker/db.test.ts test/worker/api.test.ts`

Expected: FAIL on absent tables/columns and the old unique file-pointer constraint.

- [ ] **Step 3: Update Drizzle schema**

Create provider interfaces and add the new provider/model fields. Keep relational/operational facts as columns and metadata as JSON. Add all foreign keys and indexes in the schema declaration. Retain the legacy provider/model columns only until the vertical cutover is complete; do not introduce runtime dual writes.

```ts
export const providerInterfaces = sqliteTable('provider_interfaces', {
  id: integer().primaryKey({ autoIncrement: true }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  protocol: text().$type<Protocol>().notNull(),
  base_url: text().notNull(),
  native_files: integer({ mode: 'boolean' }).notNull().default(false),
  created_at: integer().notNull(),
}, table => [uniqueIndex('provider_interfaces_provider_protocol_uq').on(table.provider_id, table.protocol)])
```

Use a nullable `providers.default_interface_id` during creation but enforce the non-empty/default ownership invariant in API writes. Add `credential_version`, models.dev association fields, resolved metadata, match JSON, and materialized filter columns.

- [ ] **Step 4: Generate and review migration artifacts**

Run: `pnpm exec drizzle-kit generate --name provider-catalog`

Expected: `migrations/0002_provider-catalog.sql`, snapshot, and journal entry are created. Review SQL so the migration:

- creates one interface per legacy provider;
- maps legacy protocols to new names;
- converts non-placeholder display names, capabilities, and pricing into metadata overrides;
- adds/backfills provider and model catalog fields while retaining legacy columns for the branch-local cutover;
- rebuilds the pointer table without the legacy unique pointer constraint;
- rejects or removes unsupported native Vertex local rows according to the approved spec rather than silently mapping credentials.

- [ ] **Step 5: Run migration and schema tests**

Run: `pnpm vitest run test/worker/db.test.ts test/worker/api.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit schema migration**

```bash
git add src/server/db/schema.ts migrations test/worker/db.test.ts test/worker/api.test.ts
git commit -m "feat(db): add provider interfaces and model metadata"
```

### Task 3: Pure catalog parsing, matching, and resolution

**Files:**
- Create: `src/server/plugins/model-catalog/types.ts`
- Create: `src/server/plugins/model-catalog/match.ts`
- Create: `src/server/plugins/model-catalog/resolve.ts`
- Test: `test/unit/model-catalog-match.test.ts`
- Test: `test/unit/model-catalog-resolve.test.ts`

**Interfaces:**
- Produces: `matchProviderByEndpoints(input, providers)`, `matchCatalogModel(input)`, `resolveModelMetadata(input)`, and `materializeModelMetadata(metadata, modelId, labName)`.
- Consumes: shared metadata types and plain parsed catalog records; no DB or KV dependency.

- [ ] **Step 1: Write failing provider-match tests**

Cover default exact match, same-origin sibling fallback, different-origin exclusion, conflicting sibling hits, trailing-slash normalization, manual association, and no match.

```ts
expect(matchProviderByEndpoints({
  defaultInterfaceId: 1,
  interfaces: [
    { id: 1, base_url: 'https://api.deepseek.com/anthropic' },
    { id: 2, base_url: 'https://api.deepseek.com/' },
  ],
}, providerIndex)).toEqual({ id: 'deepseek', source: 'endpoint' })
```

- [ ] **Step 2: Write failing model-match tests**

Cover operator provider exact/basename, Lab provider safe fallback, global exact/basename, both-slashed mismatch, basename ambiguity, and no punctuation/case normalization.

```ts
expect(matchCatalogModel({ providerId: null, modelId: 'deepseek/deepseek-v4-flash', catalog }))
  .toMatchObject({ labProvider: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' } })
```

- [ ] **Step 3: Write failing resolution tests**

Assert operator metadata includes cost/limit; Lab provider fallback includes only `reasoning_options`, `interleaved`, and `modalities`; global facts fill the remaining base; user false/zero/null overrides win; Lab prefix inference changes grouping only.

- [ ] **Step 4: Run tests and verify failure**

Run: `pnpm vitest run test/unit/model-catalog-match.test.ts test/unit/model-catalog-resolve.test.ts`

Expected: FAIL because the catalog functions do not exist.

- [ ] **Step 5: Implement deterministic pure functions**

Use exact string comparison after trailing-slash URL normalization. Keep basename matching in a helper that returns a value only for one unique candidate. Implement the Lab provider whitelist as an explicit projection.

```ts
const LAB_PROVIDER_FIELDS = ['reasoning_options', 'interleaved', 'modalities'] as const

export function labProviderFallback(model: CatalogModel): ModelMetadata {
  return Object.fromEntries(
    LAB_PROVIDER_FIELDS.flatMap(key => model[key] === undefined ? [] : [[key, model[key]]]),
  ) as ModelMetadata
}
```

Materialize filter facts from the resolved object, never from model-name heuristics.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm vitest run test/unit/model-catalog-match.test.ts test/unit/model-catalog-resolve.test.ts`

Expected: PASS.

```bash
git add src/server/plugins/model-catalog/types.ts src/server/plugins/model-catalog/match.ts src/server/plugins/model-catalog/resolve.ts test/unit/model-catalog-match.test.ts test/unit/model-catalog-resolve.test.ts
git commit -m "feat(catalog): resolve provider and model metadata"
```

### Task 4: KV catalog service, cron refresh, and status API

**Files:**
- Create: `src/server/plugins/model-catalog/index.ts`
- Create: `src/server/plugins/model-catalog/storage.ts`
- Create: `src/server/plugins/model-catalog/refresh.ts`
- Create: `src/server/plugins/api/model-catalog.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/cordis.d.ts`
- Modify: `src/server/plugins/api/index.ts`
- Modify: `src/server/index.ts`
- Modify: `wrangler.jsonc`
- Regenerate: `worker-configuration.d.ts`
- Modify: `test/env.d.ts`
- Create: `test/worker/model-catalog.test.ts`
- Modify: `test/worker/app.test.ts`

**Interfaces:**
- Produces: Cordis service `ctx.modelCatalog`; methods `refresh(source: 'cron' | 'manual'): Promise<CatalogRefreshResult>`, `status(): Promise<CatalogStatus>`, `providerIndex()`, `globalModels(version)`, and `providerModels(id, version)`.
- Consumes: `Env.MODEL_CATALOG: KVNamespace`, D1 models, and pure resolver functions from Task 3.

- [ ] **Step 1: Add the KV test binding and failing service tests**

Add `kv_namespaces: [{ "binding": "MODEL_CATALOG" }]` for local/test configuration, regenerate Worker types with `pnpm types`, and expose the binding in the test environment. Test immutable shard writes, unchanged hash no-op, active/previous pointer, failed fetch/validation preserving active, missing-current fallback, and 48-hour garbage collection.

```ts
expect(await env.MODEL_CATALOG.get('models-dev:active', 'json')).toEqual({
  current: second.version,
  previous: first.version,
})
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run test/worker/model-catalog.test.ts test/worker/app.test.ts`

Expected: FAIL because the service and routes do not exist.

- [ ] **Step 3: Implement storage and refresh**

Fetch `https://models.dev/catalog.json`, validate the provider/global envelopes, hash the original bytes with Web Crypto, and project the document into provider index, global model map, and per-provider maps. Write versioned shards and manifest before activation.

```ts
export interface CatalogPointer {
  current: string
  previous: string | null
}

export interface CatalogRefreshResult {
  version: string
  changed: boolean
  providers: number
  globalModels: number
  providerModels: number
}
```

Activate only after D1 model materialization succeeds. If the current shard is absent at a PoP, readers try `previous`. Delete only non-current/non-previous generations older than 48 hours.

- [ ] **Step 4: Provision the production KV binding**

Run the authenticated Wrangler command only after confirming it targets the repository's intended Cloudflare account:

```bash
pnpm exec wrangler kv namespace create only-chat-model-catalog --binding MODEL_CATALOG --update-config
pnpm types
```

Expected: Wrangler creates the namespace, writes its ID into `wrangler.jsonc`, and regenerated Worker types contain `MODEL_CATALOG: KVNamespace`.

- [ ] **Step 5: Wire Cordis, cron, and Hono routes**

Load the model-catalog service only on Worker side before the API plugin. Run catalog refresh and file cleanup as separately caught scheduled jobs so one failure does not suppress the other. Implement status/providers/manual-refresh routes and return counts/status only.

- [ ] **Step 6: Run worker tests and typecheck**

Run: `pnpm vitest run test/worker/model-catalog.test.ts test/worker/app.test.ts && pnpm typecheck`

Expected: PASS for the new service and Worker types.

- [ ] **Step 7: Commit catalog infrastructure**

```bash
git add src/server/plugins/model-catalog src/server/plugins/api/model-catalog.ts src/server/app.ts src/server/cordis.d.ts src/server/plugins/api/index.ts src/server/index.ts wrangler.jsonc worker-configuration.d.ts test/env.d.ts test/worker/model-catalog.test.ts test/worker/app.test.ts
git commit -m "feat(catalog): cache models.dev metadata in KV"
```

### Task 5: Provider/interface and indexed model APIs

**Files:**
- Create: `src/server/plugins/api/provider-write.ts`
- Create: `src/server/plugins/api/model-query.ts`
- Modify: `src/server/plugins/api/providers.ts`
- Modify: `src/server/plugins/api/models.ts`
- Modify: `src/server/plugins/llm/list-models.ts`
- Modify: `src/server/plugins/llm/presets.ts`
- Test: `test/worker/api.test.ts`
- Create: `test/worker/model-query.test.ts`
- Create: `test/unit/model-query-plan.test.ts`

**Interfaces:**
- Produces: atomic provider writes with interface validation and persisted models.dev association; `queryModels(db, input): Promise<ModelPage>`; `/models` import that never consumes catalog membership.
- Consumes: catalog service, schema from Task 2, resolver from Task 3.

- [ ] **Step 1: Write failing provider API tests**

Cover provider creation with two interfaces, one default, shared key encryption, manual/endpoint association, endpoint rematch, default ownership, duplicate protocol rejection, model interface ownership, and Vertex-compatible Files rejection.

- [ ] **Step 2: Write failing model API/query tests**

Cover `/models`-only import membership, manual model survival, operator metadata precedence, Lab provider safe subset, metadata reset, interface inheritance, filters, stable cursor pagination, and provider/Lab grouping fields.

Add query-plan assertions for representative SQL:

```ts
const plan = await env.DB.prepare(
  'EXPLAIN QUERY PLAN SELECT id FROM models WHERE provider_id = ? AND enabled = 1 AND supports_image_input = 1 ORDER BY sort, id LIMIT 50',
).bind(providerId).all<{ detail: string }>()
expect(plan.results.some(row => row.detail.includes('USING INDEX'))).toBe(true)
expect(plan.results.some(row => row.detail.includes('SCAN models'))).toBe(false)
```

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm vitest run test/worker/api.test.ts test/worker/model-query.test.ts test/unit/model-query-plan.test.ts`

Expected: FAIL on old provider/model contracts and absent indexes/query service.

- [ ] **Step 4: Implement atomic provider writes**

Move provider transaction logic into `provider-write.ts`. On endpoint association mode, match the default interface first, then only same-origin siblings. Increment `credential_version` only when a non-empty new key replaces or clears the stored key. Return a non-blocking association warning for conflicts.

- [ ] **Step 5: Implement model import, resolution, and query**

Keep `listRemoteModels()` as the only automatic ID source. Insert missing IDs, preserve existing/manual rows, resolve effective metadata through the current catalog, and update only changed materialized fields. Implement cursor pagination and indexed filters.

```ts
export interface ModelCursor {
  sort: number
  id: number
}

// Cursor order is stable and matches ORDER BY sort, id.
```

Do not return all catalog models from any model membership endpoint. Remove hard-coded model capabilities from presets; presets may only seed provider/interface identity and user-requested initial model IDs.

- [ ] **Step 6: Run API/query tests**

Run: `pnpm vitest run test/worker/api.test.ts test/worker/model-query.test.ts test/unit/model-query-plan.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit provider/model APIs**

```bash
git add src/server/plugins/api/provider-write.ts src/server/plugins/api/model-query.ts src/server/plugins/api/providers.ts src/server/plugins/api/models.ts src/server/plugins/llm/list-models.ts src/server/plugins/llm/presets.ts test/worker/api.test.ts test/worker/model-query.test.ts test/unit/model-query-plan.test.ts
git commit -m "feat(providers): add interfaces and catalog-backed models"
```

### Task 6: Client stores, provider creation, and interface editor

**Files:**
- Modify: `src/client/lib/api.ts`
- Modify: `src/client/stores/config.ts`
- Modify: `src/client/components/provider-navigation.vue`
- Create: `src/client/components/provider-create-dialog.vue`
- Create: `src/client/components/provider-interface-list.vue`
- Modify: `src/client/views/settings-provider-edit.vue`
- Modify: `src/client/views/settings-providers.vue`
- Test: `test/unit/client-provider-editor.test.ts`
- Create: `test/unit/client-provider-create.test.ts`
- Modify: `test/unit/client-settings.test.ts`

**Interfaces:**
- Consumes: Provider/Model/Catalog REST DTOs from Task 5.
- Produces: searchable models.dev provider creation, custom creation, atomic interface editing, default selection, catalog status/manual refresh, and a Pinia cache that retains explicitly loaded selected models across pages.

- [ ] **Step 1: Write failing provider creation/editor tests**

Test provider search, prefill from a catalog provider, custom provider creation, manual association, auto endpoint association notice, multiple interface editing, duplicate-format prevention, default switching, Vertex Files disabled state, stable unsaved labels, and leave warning.

- [ ] **Step 2: Run client tests and verify failure**

Run: `pnpm vitest run test/unit/client-provider-editor.test.ts test/unit/client-provider-create.test.ts test/unit/client-settings.test.ts`

Expected: FAIL against the old single-protocol form.

- [ ] **Step 3: Update API and Pinia clients**

Add typed catalog/provider/interface/model page calls. Replace eager `Promise.all` loading of every provider's models with:

- provider list loading;
- explicit enabled-model query for the picker;
- provider-specific paginated pages for settings;
- `modelsByRef` retention so a selected Project/session model remains renderable even outside the current page.

- [ ] **Step 4: Implement provider creation and interface editing**

Use existing shadcn-vue Dialog/Command/Field/Select/Switch components. Catalog provider choice sets source `manual`; custom creation defaults to endpoint association mode. `ProviderInterfaceList` emits one atomic interface array and prevents duplicate protocols locally before server validation.

- [ ] **Step 5: Implement catalog refresh status**

Add “刷新模型目录”, last-success time, current version, and non-layout-shifting progress/error feedback to the models settings surface. On success reload provider/model metadata without discarding unsaved provider form state.

- [ ] **Step 6: Run client tests and commit**

Run: `pnpm vitest run test/unit/client-provider-editor.test.ts test/unit/client-provider-create.test.ts test/unit/client-settings.test.ts`

Expected: PASS.

```bash
git add src/client/lib/api.ts src/client/stores/config.ts src/client/components/provider-navigation.vue src/client/components/provider-create-dialog.vue src/client/components/provider-interface-list.vue src/client/views/settings-provider-edit.vue src/client/views/settings-providers.vue test/unit/client-provider-editor.test.ts test/unit/client-provider-create.test.ts test/unit/client-settings.test.ts
git commit -m "feat(settings): manage provider interfaces and catalog"
```

### Task 7: Metadata editor, Lab grouping, and model filters

**Files:**
- Create: `src/client/components/lab-avatar.vue`
- Create: `src/client/components/model-filter-bar.vue`
- Create: `src/client/components/model-group-list.vue`
- Modify: `src/client/components/model-editor.vue`
- Modify: `src/client/components/model-picker-content.vue`
- Modify: `src/client/components/model-picker.vue`
- Modify: `src/client/views/settings-provider-edit.vue`
- Modify: `src/client/lib/ui-models.ts`
- Modify: `src/client/stores/sync.ts`
- Modify: `src/shared/models.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/server/db/schema.ts`
- Create: `migrations/0003_drop-legacy-provider-model.sql`
- Modify: `migrations/meta/0003_snapshot.json`
- Modify: `migrations/meta/_journal.json`
- Modify: `test/worker/db.test.ts`
- Test: `test/unit/client-model-picker.test.ts`
- Create: `test/unit/client-model-groups.test.ts`
- Modify: `test/unit/client-settings.test.ts`
- Modify: `test/unit/client-ui-models.test.ts`

**Interfaces:**
- Consumes: paginated effective Model DTOs and Provider interfaces.
- Produces: model filters, Lab-grouped results, human names/icons, interface inheritance/override, and field/group reset to models.dev fallback.

- [ ] **Step 1: Write failing grouping/filter tests**

Cover multi-Lab grouping, no redundant single-Lab header, exact Lab-prefix grouping without metadata inference, unknown “其他”, remote icon fallback, provider context, selected model retention, filter query serialization, and cursor append/reset.

- [ ] **Step 2: Write failing metadata editor tests**

Assert the editor shows effective value and source, writes only changed overrides, preserves explicit false/zero/null, clears one field/group back to fallback, and selects only interfaces belonging to the model provider.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm vitest run test/unit/client-model-picker.test.ts test/unit/client-model-groups.test.ts test/unit/client-settings.test.ts test/unit/client-ui-models.test.ts`

Expected: FAIL because current components use `display_name/capabilities` and local-only filtering.

- [ ] **Step 4: Implement grouped model presentation**

Group within each provider by `lab_id`, render `metadata.name ?? model_id`, show the raw ID secondarily, and load `https://models.dev/logos/labs/${encodeURIComponent(labId)}.svg`. On image error use `ProviderAvatar` without retry loops.

- [ ] **Step 5: Implement server filter controls and paging**

Serialize vision/reasoning/tools/image output/interface/Lab/min-context/search into `ModelQuery`. Reset pages on filter change, abort stale requests, and append only the matching request token. Keep the currently selected model in Pinia even when filters exclude it.

- [ ] **Step 6: Implement override-aware editor**

Bind form inputs to `metadata_override`, use effective metadata as placeholder/help text, and emit a partial override object. Derive reasoning controls from `reasoning_options`; remove the old capability conversion helpers and hand-written flags.

- [ ] **Step 7: Remove superseded shared contracts**

Remove the old single-protocol Provider DTO, `display_name`, `capabilities`, `pricing`, and legacy model inputs after every server and client consumer uses the interface/metadata contracts. Remove the corresponding legacy D1 columns from `src/server/db/schema.ts`, run `pnpm exec drizzle-kit generate --name drop-legacy-provider-model`, and review `migrations/0003_drop-legacy-provider-model.sql`. Do not retain compatibility fields or dual serialization.

- [ ] **Step 8: Run client tests, typecheck, and commit**

Run: `pnpm vitest run test/unit/client-model-picker.test.ts test/unit/client-model-groups.test.ts test/unit/client-settings.test.ts test/unit/client-ui-models.test.ts test/worker/db.test.ts && pnpm typecheck`

Expected: PASS.

```bash
git add src/client/components/lab-avatar.vue src/client/components/model-filter-bar.vue src/client/components/model-group-list.vue src/client/components/model-editor.vue src/client/components/model-picker-content.vue src/client/components/model-picker.vue src/client/views/settings-provider-edit.vue src/client/lib/ui-models.ts src/client/stores/sync.ts src/shared/models.ts src/shared/api.ts src/server/db/schema.ts migrations test/unit/client-model-picker.test.ts test/unit/client-model-groups.test.ts test/unit/client-settings.test.ts test/unit/client-ui-models.test.ts test/worker/db.test.ts
git commit -m "feat(models): add catalog metadata and Lab groups"
```

### Task 8: Catalog feature verification

**Files:**
- No planned production edits; failures return to the task that owns the affected file.
- Test: all catalog/provider/model tests from this plan

**Interfaces:**
- Consumes: complete provider/catalog implementation.
- Produces: verified, reviewable subsystem ready for the reasoning/files plan.

- [ ] **Step 1: Run focused suites**

Run:

```bash
pnpm vitest run \
  test/unit/shared-models.test.ts \
  test/unit/model-metadata.test.ts \
  test/unit/model-catalog-match.test.ts \
  test/unit/model-catalog-resolve.test.ts \
  test/unit/model-query-plan.test.ts \
  test/unit/client-provider-editor.test.ts \
  test/unit/client-provider-create.test.ts \
  test/unit/client-model-picker.test.ts \
  test/unit/client-model-groups.test.ts \
  test/worker/db.test.ts \
  test/worker/model-catalog.test.ts \
  test/worker/model-query.test.ts \
  test/worker/api.test.ts
```

Expected: PASS.

- [ ] **Step 2: Verify SQL access paths**

Run the query-plan tests and inspect every plan logged by the diagnostic helper. Expected: indexed `SEARCH`, no hot model query with `SCAN models`. Compare representative `meta.rows_read` with returned rows.

- [ ] **Step 3: Run complete verification**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: all tests/typechecks pass; build may retain only the repository's pre-existing bundle-size advisory and dependency sourcemap warnings.

- [ ] **Step 4: Perform browser QA**

Verify provider creation, endpoint association, multiple interfaces/default, `/models` import, catalog refresh success/failure, OpenRouter Lab groups, filters, pagination, override reset, narrow desktop, and mobile overlays. Do not use preview deployment or production bindings.

- [ ] **Step 5: Commit any verification-only fixes**

If verification requires a change, return to the task that owns the affected file, repeat that task's focused test cycle, and include the fix in that task's focused commit. If every task is already committed, inspect `git diff --name-only`, stage each reviewed path explicitly, and use `git commit -m "fix(models): address catalog verification findings"`. If no files changed, do not create an empty commit.
