# Ask User Plugin Shared Skeleton Report

## Files

- Added shared plugin IDs and `PluginManifest` in `src/shared/plugins.ts`.
- Added the `ask_user` manifest and strict question/result contracts in `src/plugins/ask-user/`.
- Added a Cordis `ToolRegistry` and an `ask_user` AI SDK registration without `execute` in `src/server/plugins/tools/` and `src/plugins/ask-user/server/`.
- Wired the registry into the hub-side app and Cordis declarations.
- Added `migrations/0006_session-tools.sql`, the Drizzle `sessions.tools` field, Session DTO/wire fields, first-send snapshot handling, normalized `session.update` snapshots, and fork preservation.
- Added the lazy client plugin host/discovery modules and installed the host in `src/client/main.ts`.
- Added focused contract, registry, host, websocket, sync-store, and Session persistence tests; updated Session fixtures for the new required `tools` DTO field.

## Interfaces

- `AskUserInputSchema`, `AskUserResultSchema`, and `validateAskUserResult()` strictly cover one to three unique questions, choice cardinality, text/choice exclusivity, and answered/cancelled results.
- `ToolRegistry.register(pluginId, toolId, factory)`, `normalize(ids)`, and `resolve(ids, enabledPlugins)` provide lifecycle-owned registrations, sorted unique snapshots, and fail-closed resolution.
- `Session.tools` is a stable string-ID snapshot. A new `send` can initialize it; `session.update` normalizes known IDs through `ToolRegistry`.
- `ClientPluginHost` supports eager manifests with lazy entrypoints, concurrent-load deduplication, failed-load retry, renderer lookup, and disposer cleanup.

## Tests

- `pnpm vitest run test/unit/plugin-contracts.test.ts test/unit/tool-registry.test.ts test/unit/client-plugin-host.test.ts test/unit/shared-ws.test.ts test/unit/client-sync-store.test.ts test/worker/hub-sessions.test.ts test/worker/app.test.ts test/worker/hub-do.test.ts` — 118 passed.
- `pnpm typecheck` — passed.
- `pnpm db:migrate:local` applied `0006_session-tools.sql` successfully.
- `git diff --check` — passed.

## Commit

- `feat(plugins): add ask user shared skeleton`

## Concerns

- This intentionally excludes generation tool resolution, Questionnaire rendering, Composer selection UI, tool responses, and continuation.
- Only the local D1 migration was applied; no remote database mutation was performed.
