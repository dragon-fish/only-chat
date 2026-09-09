# only-chat

Personal AI chat on Cloudflare Workers. Every device sees the same conversations and live streams.

- Four interface formats: `chat-completions`, `responses`, `anthropic`, `vertex-compatible`.
  Each provider shares one API key across its interfaces and selects one default; models can select
  another interface belonging to the same provider.
- **Projects**: an optional container carrying a prompt, a default model and default params. Nothing
  is copied into a Conversation — the effective configuration is recomputed from the latest Project
  state at the start of every generation, and each field can be overridden per Conversation.
- Prompt, model and reasoning are configurable *before* the first message: the draft and the first
  message create the Conversation in one command.
- Tree-shaped messages: editing or regenerating creates a sibling, with a branch switcher on the bubble.
- Text (markdown), pasted/dropped images, model-generated images, collapsible reasoning blocks.
- One WebSocket per user, held by a `UserHub` Durable Object. Generation runs server-side to
  completion, so any device can join, leave or reconnect mid-stream.

## Dev

    cp .dev.vars.example .dev.vars   # set both secrets; keep BETTER_AUTH_URL on this origin
    pnpm install
    pnpm db:migrate:local
    pnpm dev                          # http://localhost:5173

Registration is closed by default. For a new local database, temporarily set `ALLOW_REGISTER=true`
in `.dev.vars`, restart the dev server, and register the first account. That account receives `uid=1`
and is the fixed administrator. Close registration afterward in `/admin/settings` or by restoring
`ALLOW_REGISTER=false` when no D1 override is set.

Then open `/settings/providers`, choose a catalog provider or a custom provider, configure its
interfaces and shared API key, add a model, and start a chat.

    pnpm typecheck                    # vue-tsc + both tsc projects
    pnpm test                         # vitest (unit + worker pool)

## Deploy (first time)

    wrangler d1 create only-chat-db   # paste database_id into wrangler.jsonc
    wrangler r2 bucket create only-chat-attachments
    wrangler secret put KEY_ENCRYPTION_SECRET
    wrangler secret put BETTER_AUTH_SECRET
    pnpm db:migrate:remote
    pnpm deploy

`wrangler.jsonc` already carries a `database_id`; replace it with the id of the database you
just created. Set `BETTER_AUTH_URL` to the exact public origin in `wrangler.jsonc`; it is used for
authentication callback and origin validation. Generate independent random values for
`KEY_ENCRYPTION_SECRET` and `BETTER_AUTH_SECRET`; the latter must contain at least 32 characters.

`ALLOW_REGISTER` is a non-secret Worker variable and defaults to `false`. For a new deployment,
explicitly enable it only long enough to register the first account, which naturally receives
`uid=1` and fixed administrator privileges. Close it immediately afterward. `/admin/settings`
stores a D1 override with precedence over `ALLOW_REGISTER`; clearing that override restores the
environment value, or the default-closed behavior when the variable is absent.

Cloudflare Access removal is a deployment-time choice and is not performed by this branch. Keep
Access in place until the matching migrations and Worker are deployed and application login for
`uid=1` has been verified. Then explicitly decide whether to remove Access; leaving it enabled adds
a second authentication gate, while removing it exposes the application's public login and
registration-status routes. All business REST routes, `/ws`, and attachment downloads still require
a valid Better Auth login. Administrators can manage accounts but cannot inspect another user's
Conversations, Projects, Providers, models, attachments, messages, or settings.

## Upgrading an existing deployment

Apply migrations and deploy the matching Worker as one coordinated upgrade:

    pnpm db:migrate:remote            # 1. schema
    pnpm deploy                       # 2. code

Back up D1 and pause access during this upgrade. In particular, `0007_conversations.sql` renames the
chat `sessions` table to `conversations` and `messages.session_id` to `conversation_id`, while
`0008_user-auth.sql` adds the Better Auth and site-settings schema. The previous Worker cannot run
against the final schema, and the new Worker cannot serve an unmigrated database; a Worker-only
rollback across this boundary is unsupported.

Earlier migrations remain part of the same ordered upgrade. `0002_provider-catalog.sql` creates
provider interfaces and model metadata. `0003_provider-files-cleanup.sql` removes the old provider
protocol/address fields and model display-name/capability/pricing fields, and requires each file
pointer to have a file family and endpoint.

Provider credentials, model overrides and scoped upload history are preserved. Native Vertex
providers remain disabled with no interface; their model data is retained for explicit
reconfiguration. Legacy pointers without an addressable scope are removed locally. R2 originals
are unchanged.

Locally the same ordering applies: run `pnpm db:migrate:local` before `pnpm dev` after a pull.

Existing MVP databases already contain a credential-less `uid=1`; public registration does not
claim that row. Restore any existing account interactively, without putting passwords in arguments
or logs:

    pnpm auth:reset-user -- --userid 1 --local
    pnpm auth:reset-user -- --userid 1 --remote

The command shows the target environment, user ID, and current email before confirmation, then
prompts for name, email, and password. It replaces all login credentials and revokes all Better Auth
sessions while preserving the user ID, role, settings, Conversations, Projects, Providers, models,
and attachments. `--userid` is required, and exactly one of `--local` or `--remote` must be supplied.

## Architecture and naming

Authentication state is an `AuthSession`; a chat is a `Conversation`. D1 stores chats in
`conversations` and links each message through `messages.conversation_id`. Initial reads use
`GET /api/conversations` and `GET /api/conversations/:id/messages`, scoped to the authenticated
user. Conversation writes remain serialized by that user's `UserHub` over `/ws`; commands and
events use `conversation_id`, `conversation.update`, `conversation.delete`, `conversation.fork`,
and `conversation.created` / `conversation.updated` / `conversation.deleted` /
`conversation.forked`. The browser cannot select a user ID: the Worker derives it from the Better
Auth login before routing to the per-user Durable Object.

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
  Success and HTTP 404/410 remove the pointer. Network errors, SDK-retryable errors (including HTTP
  408/409), HTTP 401/403/429 and server errors defer it by a day; unrecoverable references are logged
  without sensitive data and removed locally.
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
    src/server/plugins/hub/             UserHub DO: WebSocket hub, Conversation commands, generation
    src/client/       Vue 3 SPA (pages, views, components, stores)
    src/shared/       zod schemas shared by both sides (models, parts, ws)
    migrations/       D1 migrations
    test/             vitest unit tests and worker-pool tests

Design notes: `docs/superpowers/specs/2026-09-05-only-chat-mvp-design.md` and
`docs/superpowers/specs/2026-09-06-projects-ui-reasoning-design.md`.
`docs/superpowers/specs/2026-09-06-unified-ui-redesign.md` supersedes their UI layout decisions.
`docs/superpowers/specs/2026-09-07-provider-catalog-and-interface-design.md` defines provider
interfaces, catalog metadata, reasoning and file lifecycle behavior.
`docs/superpowers/specs/2026-09-08-user-auth-and-conversation-naming-design.md` defines
authentication, authorization, account administration, and Conversation naming.

## Known gaps

- **Authentication methods are intentionally minimal.** Email verification, self-service password
  recovery, OAuth, Passkeys, and Magic Links are not implemented. Operators can use
  `pnpm auth:reset-user` when an account loses access.
- **Anthropic model listing only reads the first page.** `fetch-models` calls `GET /models` once
  and ignores `has_more`/pagination, so an Anthropic account with more models than fit on one page
  will only import the first page's worth.
- **Generated images are not replayed to the model.** They are stored, broadcast and rendered, but
  a later turn does not send them back as context.
