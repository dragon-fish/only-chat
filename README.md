# only-chat

Personal AI chat on Cloudflare Workers. Every device sees the same sessions and live streams.

- Four interface formats: `chat-completions`, `responses`, `anthropic`, `vertex-compatible`.
  Each provider shares one API key across its interfaces and selects one default; models can select
  another interface belonging to the same provider.
- **Projects**: an optional container carrying a prompt, a default model and default params. Nothing
  is copied into a chat — the effective configuration is recomputed from the latest Project state at
  the start of every generation, and each field can be overridden per chat.
- Prompt, model and reasoning are configurable *before* the first message: the draft and the first
  message create the session in one command.
- Tree-shaped messages: editing or regenerating creates a sibling, with a branch switcher on the bubble.
- Text (markdown), pasted/dropped images, model-generated images, collapsible reasoning blocks.
- One WebSocket per user, held by a `UserHub` Durable Object. Generation runs server-side to
  completion, so any device can join, leave or reconnect mid-stream.

## Dev

    cp .dev.vars.example .dev.vars   # set KEY_ENCRYPTION_SECRET
    pnpm install
    pnpm db:migrate:local
    pnpm dev                          # http://localhost:5173

Then open `/settings/providers`, choose a catalog provider or a custom provider, configure its
interfaces and shared API key, add a model, and start a chat.

    pnpm typecheck                    # vue-tsc + both tsc projects
    pnpm test                         # vitest (unit + worker pool)

## Deploy (first time)

    wrangler d1 create only-chat-db   # paste database_id into wrangler.jsonc
    wrangler r2 bucket create only-chat-attachments
    wrangler secret put KEY_ENCRYPTION_SECRET
    pnpm db:migrate:remote
    pnpm deploy

`wrangler.jsonc` already carries a `database_id`; replace it with the id of the database you
just created.

There is no authentication yet: put Cloudflare Access in front of the domain before exposing it.
Every route — the SPA, `/api/*`, `/ws` and attachment downloads — sits behind that single gate.
**No public exception path is required, and this release creates none**: generated and uploaded
images are served by the same authenticated `/api/attachments/:id` route as everything else, and
the model never receives a link back to this deployment.

## Upgrading an existing deployment

Apply migrations and deploy the matching Worker as one coordinated upgrade:

    pnpm db:migrate:remote            # 1. schema
    pnpm deploy                       # 2. code

`0002_provider-catalog.sql` creates provider interfaces and model metadata. `0003_provider-files-cleanup.sql`
removes the old provider protocol/address fields and model display-name/capability/pricing fields,
and requires each file pointer to have a file family and endpoint. Back up D1 and pause access during
this upgrade: the previous Worker cannot run against the final schema, and a Worker-only rollback
across this migration boundary is unsupported.

Provider credentials, model overrides and scoped upload history are preserved. Native Vertex
providers remain disabled with no interface; their model data is retained for explicit
reconfiguration. Legacy pointers without an addressable scope are removed locally. R2 originals
are unchanged.

Locally the same ordering applies: run `pnpm db:migrate:local` before `pnpm dev` after a pull.

## Providers

### Interfaces and Vertex-compatible gateways

A provider owns its name, shared API key and enabled state. Each configured format owns its Base URL
and Files setting. Models follow the provider default unless they explicitly select another owned
interface. API addresses and keys cannot be overridden on an individual model.

`vertex-compatible` takes an ordinary Base URL and
a plain API key sent as `Authorization: Bearer <key>`; Google's own `x-goog-api-key` header is
stripped. Requests are addressed as `{base_url}/v1/publishers/{publisher}/models/{model}`, so model
ids are entered as **`{publisher}/{model}`** (for example `google/gemini-3-pro-preview`). Only the
first slash separates the two halves, so a model name containing slashes survives intact.

Remote model import is disabled when the default interface is Vertex-compatible. Native Google
Vertex service-account authentication, Project and Location configuration are unsupported.

### Model metadata

models.dev supplies fallback names, capabilities, reasoning options, limits and prices. Per-model
metadata overrides take precedence, including explicit false, zero and nullable values. Catalog
refreshes never add models: remote `/models` results and manual entries determine membership.

`reasoning_options` controls available effort levels and whether explicit reasoning disablement is
supported. `modalities` describes image input and output; `tool_call` describes tool support.
Reasoning settings affect the current request only. Returned reasoning and its provider metadata
are stored and replayed regardless of the toggle or capability metadata.

Reasoning strength itself is three-state everywhere: absent means *inherit* from the Project,
`null` means *explicit Auto* (reasoning on, no effort sent), and a string is an explicit strength.

### `native_files`: scoped uploads and remote cleanup

Files is configured per interface and defaults off. Enable it for endpoints that implement the
corresponding Files API. Responses and Chat Completions use OpenAI Files; Anthropic uses Anthropic
Files. Vertex-compatible interfaces have no Files API. Without native Files, attachment transport
uses supported URLs or inline bytes.

With it on:

- Upload reuse is scoped to the attachment, provider, credential version, Files family and normalized
  Base URL. Responses and Chat Completions share pointers when they use the same file endpoint.
  Each upload creates a new row; expired historical references remain available for remote cleanup.
- Uploads ask for a **seven-day** expiry. If the provider reports its own `expires_at`, that value is
  what gets stored; otherwise the local pointer dies on the deadline the upload asked for.
- The daily cron (`0 3 * * *`) independently refreshes the catalog and deletes expired remote files.
  Cleanup reads indexed due pointers in pages, with bounded concurrency and a per-run limit.
  Success and HTTP 404/410 remove the pointer. Network errors, HTTP 401/403/429 and server errors
  defer it by a day; unrecoverable references are logged without sensitive data and removed locally.
- Provider deletion, interface removal, key replacement and endpoint changes attempt affected
  remote deletes before changing the configuration. The operation proceeds despite remote failure;
  invalidated pointers are removed and old credentials are never retained for retries.
- Expired pointers never participate in generation. Cleanup never deletes R2 originals.

## Images

R2 is the only durable store for image bytes, uploaded and generated alike. A model's image output
is validated, hashed, written to R2 and reduced to an `attachment_id` *before* anything else sees
it, so D1 message JSON, the Durable Object's in-flight snapshot and every WebSocket frame carry the
id and nothing else — never base64, never raw bytes, never the provider's temporary URL. Identical
bytes dedupe by SHA-256. If any step fails, the reply ends as an error with its text intact and no
orphan row, no half-written R2 object and no file content anywhere.

## Layout

    src/server/       Worker entry, cordis app, plugins (database, assets, llm, hub, api)
    src/server/plugins/llm/protocols/   one plugin per provider protocol
    src/server/plugins/hub/             UserHub DO: websocket hub, session commands, generation
    src/client/       Vue 3 SPA (pages, views, components, stores)
    src/shared/       zod schemas shared by both sides (models, parts, ws)
    migrations/       D1 migrations
    test/             vitest unit tests and worker-pool tests

Design notes: `docs/superpowers/specs/2026-09-05-only-chat-mvp-design.md` and
`docs/superpowers/specs/2026-09-06-projects-ui-reasoning-design.md`.
`docs/superpowers/specs/2026-09-06-unified-ui-redesign.md` supersedes their UI layout decisions.
`docs/superpowers/specs/2026-09-07-provider-catalog-and-interface-design.md` defines provider
interfaces, catalog metadata, reasoning and file lifecycle behavior.

## Known gaps

- **No authentication.** `user_id` is hard-coded to `1`. Cloudflare Access is the intended gate and
  is already configured in front of `chat.epb.wiki`.
- **Feature plugins: mechanism reserved, not wired up.** Settings carry a per-user plugin toggle
  map and there's a toggle UI for it, but the DO does not yet load or dispose feature plugins from
  that map, and no feature plugin ships yet, so the page is empty.
- **Anthropic model listing only reads the first page.** `fetch-models` calls `GET /models` once
  and ignores `has_more`/pagination, so an Anthropic account with more models than fit on one page
  will only import the first page's worth.
- **Generated images are not replayed to the model.** They are stored, broadcast and rendered, but
  a later turn does not send them back as context.
