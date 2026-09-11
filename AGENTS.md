# AGENTS.md

This file provides guidance to coding agents working in this repository.

`README.md` is the human front page: features, deployment, configuration, known gaps. Behaviour is
documented in `docs/` — `deployment.md`, `development.md`, `providers.md`, `files.md`,
`architecture.md`. Read the relevant one before changing anything user-visible, and keep it current.

## Project Structure & Module Organization

`src/client/` contains the Vue 3 SPA: route files live in `pages/`, page-level screens in `views/`,
reusable components in `components/`, and shadcn-vue primitives in `ui/`. `src/server/` contains the
Cloudflare Worker, Hono APIs, Durable Object hub, database integration, and LLM protocol adapters.
Put cross-runtime Zod schemas and types in `src/shared/`; plugin implementations belong in
`src/plugins/`. D1 migrations are ordered SQL files under `migrations/`. Tests are split between fast
`test/unit/` cases and Cloudflare worker-pool tests in `test/worker/`. Static assets belong in
`public/`; maintenance utilities belong in `scripts/`.

## Commands

```bash
pnpm install                      # pinned pnpm dependencies
pnpm db:migrate:local             # required after every pull that adds a migration
pnpm dev                          # http://localhost:7456
pnpm build                        # production bundle
pnpm typecheck                    # vue-tsc app + tsc worker + test + scripts — the only static gate
pnpm test                         # both vitest projects
pnpm seed:mock                    # local provider that never reaches a real API

pnpm vitest run test/unit/llm-messages.test.ts          # one file
pnpm vitest run --project unit                          # one project: unit | worker
pnpm vitest run --project worker -t 'tool result'       # one test by name

pnpm db:generate                  # drizzle-kit, after editing src/server/db/schema.ts
pnpm db:migrate:remote            # production schema; never automatic
```

There is no lint or formatter.

### Extra worktrees

`.wrangler/` (the local D1, R2 and Durable Object state) and `.dev.vars` are both gitignored, so a
fresh worktree starts with no database and no secrets. Copy both over from the main checkout instead
of regenerating them: `KEY_ENCRYPTION_SECRET` has to be the one that encrypted the database it
arrives with, or every stored provider key fails to decrypt.

Nothing in either is port-specific, so the copy needs no edits — the app's origin is derived from
each request rather than configured. Just pick a free port:

```bash
pnpm dev --port 7457
```

### Deployment

Production deploys through **Cloudflare Workers Builds**, not GitHub Actions: pushing `main` *is* the
release, with no further approval step.

Remote migrations are never part of that build. Before pushing `main`, check whether the range being
pushed adds anything under `migrations/`; if it does, run `pnpm db:migrate:remote` first. A Worker
deployed against an unmigrated production database does not degrade — it stops working.

## Architecture

### Three cordis roots, one Worker

`src/server/index.ts` exports the `fetch`/`scheduled` handler, the `UserHub` Durable Object, two
Workflows (`ModelCatalogRefreshWorkflow`, `ArtifactGenerationWorkflow`) and the browser plugin's
entrypoints. All of them build a cordis `Context` through `createApp({ side })` in
`src/server/app.ts`, and **each side loads a different plugin set**:

| side | where it runs | has |
| --- | --- | --- |
| `worker` | the Worker isolate | `auth`, `modelCatalog`, `api` (Hono), plugin HTTP routes, `imageBackends` |
| `hub` | one per `UserHub` DO instance | `llm`, `tools`, `pluginChannel`, feature plugins, `hub` |
| `workflow` | inside a Workflow step | `llm`, `imageBackends` |

Services are declared on the `Context` interface in `src/server/cordis.d.ts`. Two consequences worth
internalizing: a service you reach for may simply not exist on your side (`ctx.auth` is absent in the
hub, `ctx.hub` is absent in the Worker), and `await ctx.plugin(X)` resolves even when the plugin
stays PENDING on a missing injection — which is why `app.ts` asserts `ctx.get('...')` after each
load instead of failing later at first use.

### Reads are REST, writes and streams are one WebSocket

Initial page loads call `/api/...` (Hono routes under `src/server/plugins/api/`, behind a Better Auth
session guard). Everything that mutates a conversation goes over a single `/ws` socket to that user's
`UserHub`, so writes are serialized per user and any device can join a stream in progress. The Worker
derives the user id from the login and passes it to the DO in an internal header; the browser can
never select one.

The wire protocol is one zod discriminated union per direction in `src/shared/ws.ts`. A protocol
change touches three places: that file, `Hub.handleCommand` in `src/server/plugins/hub/index.ts`, and
the client store `src/client/stores/sync.ts`.

The public origin is never configured. Better Auth derives it from each request, and the WebSocket
upgrade records it as `Hub.publicOrigin`, which is how a tool running inside the DO — with no request
of its own — hands out an absolute link. Do not reintroduce a `BETTER_AUTH_URL` var: `nodejs_compat`
copies Worker vars into `process.env`, which Better Auth reads *before* it looks at the request, so
one value pinned for production silently becomes the origin in local dev too.

### Generation

`src/server/plugins/hub/generation.ts` runs `streamText` **inside** the DO, awaited by
`webSocketMessage` so the DO stays alive for the whole turn. In-flight assistant messages are mirrored
into DO storage and recovered in `Hub[Service.init]`, with an alarm as watchdog; a disconnect does not
cancel a generation.

The effective configuration (prompt, model, params, reasoning, tools, plugin settings) is resolved
**once** at generation start by `hub/effective-config.ts` — Project → Conversation override → the
per-turn selection carried on the command — and is never re-read while the stream runs. Nothing is
copied into the conversation row at creation time; it is recomputed from the live Project every turn.
Reasoning strength is three-state everywhere: absent = inherit, `null` = explicit auto, string =
explicit effort.

Messages form a tree: editing or regenerating inserts a sibling and moves the conversation head
(`hub/tree.ts`, `hub/conversations.ts`).

### LLM protocols

`ctx.llm` (`src/server/plugins/llm/index.ts`) is a registry keyed by
`provider_interfaces.protocol`; each adapter in `protocols/` supplies `createModel` and optionally
`createFiles` / `createImages`, and the absence of the optional halves *is* the capability check
(`hasFiles`, `hasImages`). A provider owns one API key and one or more interfaces; models pick an
interface belonging to their provider. Keys are encrypted at rest (`llm/crypto.ts`).

`MockProviderPlugin` is loaded last and only under `import.meta.env.DEV` because it wraps the real
registrations; it replaces the transport while keeping a real protocol, so file support, image
allow-lists and reasoning stay on their normal path.

### Attachments and generated images

R2 is the only durable store for file bytes — uploads, generated images and binary workspace files. A
model's image output is validated, hashed and written to R2 before anything else sees it
(`hub/generated-images.ts`), so D1 JSON, the DO snapshot and every WebSocket frame carry an
`attachment_id` and never base64, raw bytes or a provider URL. What actually gets sent upstream — a
provider file id, a URL, or inline bytes — is decided per turn by `hub/attachment-transport.ts`
together with `llm/files/`.

The core never puts tool context into a conversation: it hands attachments to the model and nothing
more. Naming files (`asset:<sha256 prefix>`), reading them on demand and resolving plugin schemes
such as `vfs:` belong to the `file_reader` plugin, which reaches the prompt only through the
`generation/prepare` event and the optional `FileLabeler` in `llm/messages.ts`. Every tool that takes
a file goes through the `fileReader` service. The model never sees an `attachment_id`.

### Feature plugins

A plugin lives in `src/plugins/<id>/` as `manifest.ts` + `shared.ts` + `client/` + `server/`. Its
tools run in the hub root; its HTTP routes run in the Worker root. **Those are different cordis
roots**, so a single plugin object injecting both would hang PENDING forever — the two halves are
registered as separate plugins (see `workspace-files`, which has both `server/index.ts` and
`server/api.ts`).

A plugin that cannot work without another declares it in its manifest's `requires` and injects that
plugin's service on the server; `test/worker/plugin-requirements.test.ts` holds the two to each
other. Switches and tool selections cascade along `requires` (`src/shared/plugins.ts`).

Registration is explicit in three lists, and adding a plugin means editing all three:
`src/shared/plugin-manifests.ts` (the declarations both sides read), `src/client/plugins/loaders.ts`
(lazy client chunks) and `src/server/app.ts`. Server routes are mounted via `ctx.pluginApi.register`
(behind the session guard) or `registerPublic` (in front of it, for callers a cookie cannot reach,
such as a sandboxed frame); everything is namespaced by plugin id — `/api/plugins/<id>/…`,
`/settings/plugins/<id>`.

### Client

Vue 3 + Pinia + Tailwind 4. Routes are file-based (unplugin-vue-router over `src/client/pages/`);
page files are thin wrappers that render a screen from `src/client/views/`. `src/client/ui/` is
shadcn-vue primitives — treat it as vendored and prefer `src/client/components/` for app-specific
pieces. `stores/sync.ts` is the centre of gravity: it owns the WebSocket client, the optimistic
conversation/message state and the reasoning control model.

### Data

Drizzle schema in `src/server/db/schema.ts`, hand-ordered SQL in `migrations/`. Everything is scoped
by `user_id`; `test/worker/tenant-isolation.test.ts` exists to keep it that way.

### Build quirk

`pnpm dev` and `pnpm build` first run `scripts/build-browser-runtime.ts`, which esbuild-bundles the
browser plugin's Dynamic Worker harness into `public/browser-runtime/` (generated, gitignored). The
`BrowserRunner` entrypoint reads it from static assets at runtime, so a stale or missing bundle breaks
the browser tool rather than the build.

## Coding Style & Naming Conventions

Use TypeScript, two-space indentation, single quotes, and no semicolons, matching existing files.
Vue SFCs use `<script setup lang="ts">`; templates commonly use Pug. Name Vue files and utilities in
kebab-case (`model-picker.vue`, `image-prep.ts`), components in PascalCase when imported, and tests
`<subject>.test.ts`. Prefer the `@/` alias for `src/` imports. With no standalone formatter or lint
command, keep edits consistent and rely on `pnpm typecheck` for static validation.

## Testing

Vitest runs as two projects, selected with `--project`:

- `unit` — node environment with a `happy-dom` `localStorage` shim; covers shared schemas, client
  components and pure server logic.
- `worker` — `@cloudflare/vitest-plugin` with a miniflare D1 that has the real migrations applied in
  `test/worker/apply-migrations.ts`; covers the API, the DO, generation and migrations.

Worker tests reach into the DO with `runInDurableObject` and the `UserHub.app` getter, which exists
for that purpose. `test/worker/ws-helper.ts`, `user-fixture.ts` and `auth-helper.ts` are the entry
points for anything conversation-shaped.

Add tests for behavior, edge cases, and broken contracts — not wording or private implementation
details. Run the narrowest relevant test file first; reserve the full suite for merge or release
validation.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commits style: `feat(hub): ...`, `fix(images): ...`, or
`refactor(plugins): ...`. Keep each commit focused and write messages in English. Pull requests
should explain user-visible behavior, note migrations or configuration changes, link the relevant
issue, and include screenshots for UI changes. Report the targeted checks run. Never commit
`.dev.vars`, API keys, or production secrets.

## Licensing

Core code is AGPL-3.0-only with the plugin exception (`PLUGIN-EXCEPTION.md`); `src/plugins/` is MIT
(`src/plugins/LICENSE`); the name and the artwork in `public/logo/` are reserved (`TRADEMARKS.md`).
Code ported from another project keeps its origin and copyright in the file and gets a row in
`NOTICE.md` — a missing notice is a licence breach, not a style nit.

## Design notes

`docs/superpowers/specs/` holds the design documents the code cites in comments as "spec §x.y".
When a comment references a spec section, that document is the authority on the intended behaviour.
