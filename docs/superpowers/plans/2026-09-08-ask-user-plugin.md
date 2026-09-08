# Ask User Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lazily loaded `ask_user` feature plugin whose tool calls render durable Questionnaire cards and resume generation after validated user answers.

**Architecture:** Built-in plugins live in `src/plugins/<id>` with shared, client, and server entrypoints. A lightweight client host discovers manifests eagerly and client code lazily; a Cordis ToolRegistry registers server tools. Sessions persist a stable tool-ID snapshot, while unmatched tool-call Parts are the durable human-wait state.

**Tech Stack:** Vue 3, Pinia, shadcn-vue Questionnaire, Cordis, AI SDK 7, Zod, Cloudflare Durable Objects, D1/Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-ask-user-plugin-design.md`

## Global Constraints

- Waiting for a user never keeps a Worker invocation, DO task, Queue item, or Workflow active.
- Client plugin implementation chunks load only when settings, Session selection, or historical Parts require them.
- Session tools and model tool definitions use stable sorted IDs to preserve prefix caches.
- Pending `ask_user` calls remain answerable after global plugin disablement.
- Questionnaire choice shortcuts use numeric mode.
- Third-party SDK and Questionnaire internals are not unit-tested.

---

### Task 1: Shared plugin contracts and discovery metadata

**Files:**
- Create: `src/shared/plugins.ts`
- Create: `src/plugins/ask-user/manifest.ts`
- Create: `src/plugins/ask-user/shared.ts`
- Test: `test/unit/plugin-contracts.test.ts`

**Interfaces:**
- Produces: `PluginManifest`, `AskUserInputSchema`, `AskUserResultSchema`, `AskUserInput`, `AskUserResult`, and the stable IDs `ask_user`.

- [ ] **Step 1: Write failing schema tests**

Cover one-to-three questions, unique question IDs, choice option cardinality, text questions rejecting options, answer value type matching question type, and cancelled results.

```ts
expect(AskUserInputSchema.parse({ questions: [singleQuestion] })).toEqual({ questions: [singleQuestion] })
expect(() => AskUserInputSchema.parse({ questions: [] })).toThrow()
expect(() => AskUserInputSchema.parse({ questions: [singleQuestion, singleQuestion] })).toThrow(/unique/i)
expect(AskUserResultSchema.parse({ status: 'cancelled', message: '用户选择了取消回答' })).toMatchObject({ status: 'cancelled' })
```

- [ ] **Step 2: Run the tests and verify the missing contracts fail**

Run: `pnpm vitest run test/unit/plugin-contracts.test.ts`

- [ ] **Step 3: Implement strict shared schemas and manifest**

```ts
export interface PluginManifest {
  id: string
  name: string
  description: string
  defaultTools: readonly string[]
}

export const AskUserInputSchema = z.strictObject({
  questions: z.array(AskUserQuestionSchema).min(1).max(3),
}).superRefine(uniqueQuestionIds)
```

- [ ] **Step 4: Run the schema tests**

Run: `pnpm vitest run test/unit/plugin-contracts.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/shared/plugins.ts src/plugins/ask-user/manifest.ts src/plugins/ask-user/shared.ts test/unit/plugin-contracts.test.ts
git commit -m "feat(plugins): define ask user contracts"
```

### Task 2: Server ToolRegistry and stable AI SDK tool resolution

**Files:**
- Create: `src/server/plugins/tools/index.ts`
- Create: `src/plugins/ask-user/server/index.ts`
- Modify: `src/server/cordis.d.ts`
- Modify: `src/server/app.ts`
- Test: `test/unit/tool-registry.test.ts`

**Interfaces:**
- Consumes: shared ask-user input schema from Task 1.
- Produces: `ToolRegistry.register(pluginId, toolId, factory)`, `ToolRegistry.resolve(ids, enabledPlugins)`, and an AI SDK tool without `execute`.

- [ ] **Step 1: Write failing registry tests**

Assert stable ID ordering, unknown-ID rejection, global-plugin filtering, and disposer behavior.

```ts
expect(registry.resolve(['z', 'a'], { pluginA: true }).map(([id]) => id)).toEqual(['a', 'z'])
expect(() => registry.resolve(['missing'], { pluginA: true })).toThrow(/unknown tool/i)
dispose()
expect(() => registry.resolve(['ask_user'], { ask_user: true })).toThrow()
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run test/unit/tool-registry.test.ts`

- [ ] **Step 3: Implement the Cordis service and ask-user server plugin**

Register `tool({ description, inputSchema: AskUserInputSchema })` with no `execute` member. Load the service and built-in server plugin from `createApp({ side: 'hub' })`.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm vitest run test/unit/tool-registry.test.ts
git add src/server src/plugins/ask-user/server test/unit/tool-registry.test.ts
git commit -m "feat(plugins): register server tools"
```

### Task 3: Persist per-Session tool snapshots

**Files:**
- Create: `migrations/0006_session-tools.sql`
- Modify: `src/server/db/schema.ts`
- Modify: `src/shared/models.ts`
- Modify: `src/shared/ws.ts`
- Modify: `src/server/plugins/hub/sessions.ts`
- Modify: `src/server/plugins/hub/generation.ts`
- Modify: `src/server/plugins/hub/index.ts`
- Modify: `src/client/stores/sync.ts`
- Test: `test/unit/shared-ws.test.ts`
- Test: `test/unit/client-sync-store.test.ts`
- Test: `test/worker/hub-sessions.test.ts`
- Test: `test/worker/hub-generation.test.ts`

**Interfaces:**
- Produces: `Session.tools: string[]`, first-send `tools`, and `session.update.tools`.

- [ ] **Step 1: Write failing persistence tests**

Assert existing rows default to `[]`, first send stores the draft selection, later sends omit init tools, and `session.update` stores a sorted unique snapshot without editing other Sessions.

- [ ] **Step 2: Verify failures**

Run: `pnpm vitest run test/unit/shared-ws.test.ts test/unit/client-sync-store.test.ts test/worker/hub-sessions.test.ts`

- [ ] **Step 3: Add the D1/DTO/command fields**

```sql
ALTER TABLE `sessions` ADD `tools` text NOT NULL DEFAULT '[]';
```

Normalize every incoming snapshot with `Array.from(new Set(ids)).sort()` after registry validation.

- [ ] **Step 4: Extend draft and effective Session state**

Add explicit draft tools to `SessionDraft` and `sendCommandFor`; include them only when `session_id === null`. Existing Sessions always display their stored snapshot. Task 6 derives the initial draft selection from client manifests.

- [ ] **Step 5: Resolve stable tools for generation**

Resolve the persisted snapshot through ToolRegistry and `user.settings.plugins`, reject selected tools on a model whose metadata does not declare `tool_call`, and pass `tools: Object.fromEntries(resolved)` to `streamText`. Extend the mock stream test to assert an `ask_user` call persists without a `tool_result` or automatic second generation.

- [ ] **Step 6: Run tests and apply the local migration**

```bash
pnpm vitest run test/unit/shared-ws.test.ts test/unit/client-sync-store.test.ts test/worker/hub-sessions.test.ts test/worker/hub-generation.test.ts
pnpm db:migrate:local
```

- [ ] **Step 7: Commit**

```bash
git add migrations/0006_session-tools.sql src test
git commit -m "feat(sessions): persist selected tools"
```

### Task 4: Atomically persist tool responses and resume generation

**Files:**
- Modify: `src/shared/ws.ts`
- Modify: `src/server/plugins/hub/sessions.ts`
- Modify: `src/server/plugins/hub/generation.ts`
- Modify: `src/server/plugins/hub/index.ts`
- Modify: `src/client/stores/sync.ts`
- Test: `test/worker/hub-generation.test.ts`
- Test: `test/unit/shared-ws.test.ts`

**Interfaces:**
- Consumes: `AskUserResultSchema` and ToolRegistry.
- Produces: `tool.respond`, `tool.continue`, atomic `appendToolResult`, and continuation from an arbitrary leaf Message.

- [ ] **Step 1: Write failing command and state-machine tests**

Cover ownership, unknown calls, schema-invalid answers, identical retries, conflicting retries, cancellation, all-calls-answered continuation, unresolved-call waiting, and existing-child deduplication.

- [ ] **Step 2: Verify failures**

Run: `pnpm vitest run test/unit/shared-ws.test.ts test/worker/hub-generation.test.ts`

- [ ] **Step 3: Implement the atomic JSON append**

Use one conditional D1 statement whose `WHERE NOT EXISTS` scans only the target Message's JSON Parts:

```sql
UPDATE messages
SET parts = json_insert(parts, '$[#]', json(?))
WHERE id = ?
  AND NOT EXISTS (
    SELECT 1 FROM json_each(parts)
    WHERE json_extract(value, '$.type') = 'tool_result'
      AND json_extract(value, '$.call_id') = ?
  )
RETURNING *
```

On zero updated rows, load the existing result: equal content is idempotent; different content is a conflict.

- [ ] **Step 4: Broadcast and continue**

Broadcast the appended Part as `message.part`. Generalize context assembly to a `leafMessageId`. If every call is answered and none cancelled, ensure one child assistant shell and invoke the existing generation function. `tool.continue` runs only the idempotent child/continuation check.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run test/unit/shared-ws.test.ts test/worker/hub-generation.test.ts
git add src test
git commit -m "feat(tools): resume generation after user input"
```

### Task 5: Lazy client Plugin Host

**Files:**
- Create: `src/client/plugins/host.ts`
- Create: `src/client/plugins/loaders.ts`
- Modify: `src/client/main.ts`
- Test: `test/unit/client-plugin-host.test.ts`

**Interfaces:**
- Produces: `ClientPluginHost.install(setup)`, `tools.register(id, renderer)`, `ensurePlugin(id)`, `ensureToolRenderer(id)`, and disposer-based registration.

- [ ] **Step 1: Write failing host tests**

Assert one concurrent lazy load, renderer registration, disposal, retry after failed load, and on-demand loading for a disabled plugin's historical tool call.

- [ ] **Step 2: Verify failures**

Run: `pnpm vitest run test/unit/client-plugin-host.test.ts`

- [ ] **Step 3: Implement manifest and client entrypoint discovery**

```ts
const manifests = import.meta.glob('../../plugins/*/manifest.ts', { eager: true, import: 'default' })
const clientModules = import.meta.glob('../../plugins/*/client/index.ts')
```

Map plugin/tool IDs to loaders without importing Vue cards. Deduplicate pending loads and retain a disposer for HMR or disable cleanup.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm vitest run test/unit/client-plugin-host.test.ts
git add src/client/plugins src/client/main.ts test/unit/client-plugin-host.test.ts
git commit -m "feat(plugins): lazy load client plugins"
```

### Task 6: Composer tool selector and plugin settings

**Files:**
- Create: `src/client/components/tool-selector.vue`
- Modify: `src/client/components/composer.vue`
- Modify: `src/client/views/chat.vue`
- Modify: `src/client/views/settings-plugins.vue`
- Modify: `src/client/stores/sync.ts`
- Test: `test/unit/client-tool-selector.test.ts`
- Test: `test/unit/client-settings.test.ts`

**Interfaces:**
- Consumes: manifests, lazy host, Session tools, global plugin state.
- Produces: draft/existing Session tool selection UI and model-capability send guard.

- [ ] **Step 1: Write failing UI behavior tests**

Assert enabled-plugin defaults on a new draft, unchanged existing Session snapshots, sorted updates, global disable filtering without snapshot deletion, Popover vs Drawer surfaces, and blocked send for a non-tool model.

- [ ] **Step 2: Verify failures**

Run: `pnpm vitest run test/unit/client-tool-selector.test.ts test/unit/client-settings.test.ts`

- [ ] **Step 3: Implement the selector and settings catalog**

Render the tool button in Composer `left-controls`. Use Popover on desktop and Drawer on mobile. Render plugin settings from manifests with absent persisted values treated as disabled.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm vitest run test/unit/client-tool-selector.test.ts test/unit/client-settings.test.ts
git add src/client src/plugins test/unit
git commit -m "feat(chat): select session tools"
```

### Task 7: Questionnaire tool renderer

**Files:**
- Create: `src/plugins/ask-user/client/ask-user-card.vue`
- Create: `src/plugins/ask-user/client/index.ts`
- Create: `src/client/components/tool-part-renderer.vue`
- Modify: `src/plugins/ask-user/client/index.ts`
- Modify: `src/client/components/message-item.vue`
- Test: `test/unit/client-ask-user.test.ts`

**Interfaces:**
- Consumes: ClientPluginHost renderer registry, shared schemas, `tool.respond`, `tool.continue`.
- Produces: durable pending/answered/cancelled card rendering.

- [ ] **Step 1: Write failing card tests**

Cover single/multiple/text serialization, numeric shortcuts, 1–3 step navigation, unified submit, cancel result, terminal read-only states, reconnect reconstruction, and “继续” only for answered head calls with no child.

- [ ] **Step 2: Verify failures**

Run: `pnpm vitest run test/unit/client-ask-user.test.ts`

- [ ] **Step 3: Implement declarative Part rendering**

`tool-part-renderer.vue` asks the host for a renderer by `part.name`; while the lazy chunk loads it shows a Skeleton, and unknown tools use the generic tool-call card. MessageItem pairs each `tool_call` with its matching result before rendering.

- [ ] **Step 4: Compose Questionnaire**

Use `Questionnaire shortcuts="numbers"` with QuestionnaireItem, Choice/Choices, Input, Previous, Next, Progress, Submit, and an explicit cancel action. Keep drafts local; send only the final result.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run test/unit/client-ask-user.test.ts
git add src/client/components src/plugins/ask-user/client test/unit/client-ask-user.test.ts
git commit -m "feat(ask-user): render questionnaire tool calls"
```

### Task 8: Cross-protocol and release verification

**Files:**
- Modify: `test/unit/llm-messages.test.ts`
- Modify: `test/worker/hub-generation.test.ts`
- Modify: `docs/superpowers/specs/2026-09-08-ask-user-plugin-design.md` only if implementation contracts changed.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified end-to-end plugin flow ready for deployment.

- [ ] **Step 1: Add retained protocol-order regression fixtures**

Assert product-owned `buildModelMessages` output can express answered and cancelled results followed by a user turn. Do not assert SDK-private request classes or DOM.

- [ ] **Step 2: Run focused integration tests**

```bash
pnpm vitest run test/unit/llm-messages.test.ts test/worker/hub-generation.test.ts test/unit/client-ask-user.test.ts
```

- [ ] **Step 3: Run full verification**

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

- [ ] **Step 4: Inspect migration state before deployment**

```bash
pnpm wrangler d1 migrations list only-chat-db --local
pnpm wrangler d1 migrations list only-chat-db --remote
```

- [ ] **Step 5: Commit final integration adjustments**

```bash
git add src test docs migrations
git commit -m "feat: complete ask user plugin flow"
git push origin feat/ask-user-plugin
```
