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
- Text (markdown), pasted/dropped images, PDF, audio and video uploads (site-configurable formats and size, 20 MiB by default), model-generated images, collapsible reasoning blocks.
- Desktop turn navigation uses a slim rail beside the transcript: hover for a question/reply
  preview, click to jump, or scroll the rail independently in long conversations. Mobile uses
  an outline button. Both mark the turn currently being read.
- One WebSocket per user, held by a `UserHub` Durable Object. Generation runs server-side to
  completion, so any device can join, leave or reconnect mid-stream.

## Dev

    cp .dev.vars.example .dev.vars   # set both secrets
    pnpm install
    pnpm db:migrate:local
    pnpm dev                          # http://localhost:7456

Registration is closed by default. For a new local database, temporarily set `ALLOW_REGISTER=true`
in `.dev.vars`, restart the dev server, and register the first account. That account receives `uid=1`
and is the fixed administrator. Close registration afterward in `/admin/settings` or by restoring
`ALLOW_REGISTER=false` when no D1 override is set.

Then open `/settings/providers`, choose a catalog provider or a custom provider, configure its
interfaces and shared API key, add a model, and start a chat.

### Mock provider

`pnpm seed:mock` creates a local Provider whose interface points at `mock.invalid`, a host reserved
by RFC 2606 that never resolves. The mock adapter is registered only behind `import.meta.env.DEV`
and answers those interfaces locally, so chats stream generated text without reaching any API and
without spending anything. The interface keeps a real protocol (`responses`), so protocol-dependent
behaviour upstream — native file support, image protocol allow-lists, reasoning handling — stays on
its normal path; only the transport is replaced.

Directives at the start of the newest user message shape the reply:

| Directive | Effect |
| --- | --- |
| `/tool_call <name> <json>` | one tool call with that JSON as its input |
| `/parallel [{"name":…,"args":…},…]` | several tool calls in one turn |
| `/reasoning [text]` | reasoning followed by text |
| `/error [message]` | a provider failure |
| `/slow [ms]` | text streamed with a delay between chunks |

Anything else — including a malformed directive — streams ordinary generated text.

The `mock-image` model serves Image Studio: each run downloads a placeholder photo from
`picsum.photos` at the requested size (the dev server needs direct internet access for this; it does
not go through a proxy). Directives do not apply to it. Pass `--user <id>`
to seed for a user other than `1`. The command is idempotent and local-only.

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
just created, and point `routes` at your own hostname. The application's public origin is not
configured anywhere: authentication and the links tools hand out both derive it from the request
that arrived, so the route binding is what decides it. Generate independent random values for
`KEY_ENCRYPTION_SECRET` and `BETTER_AUTH_SECRET`; the latter must contain at least 32 characters.

`ALLOW_REGISTER` is a non-secret Worker variable and defaults to `false` in `wrangler.jsonc`. For a new deployment,
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

The one exception is the owner audit: with `ENABLE_AUDIT` set to exactly `true`, `uid=1` alone gets
two read-only site-wide listings, `/admin/audit/conversations` (with transcripts) and
`/admin/audit/providers` (names, interface URLs, enabled models; never the key), listed under
站点管理 in settings. Every audit request logs the viewer and the path to the Worker log.
`ENABLE_AUDIT` defaults to `false` in `wrangler.jsonc`, so a fork starts with the audit off;
`.dev.vars` overrides it locally. A var declared in `wrangler.jsonc` overrides the dashboard on every
deploy (`keep_vars` only protects undeclared ones), so a deployment enables it in its Workers Builds
deploy command: `npx wrangler deploy --var ENABLE_AUDIT:true`.

## Upgrading an existing deployment

Before the schema/code cutover, update `wrangler.jsonc`: point `routes` at this deployment's own
hostname rather than the repository's example, and set `ALLOW_REGISTER=false`. A `BETTER_AUTH_URL`
left over from an earlier release is now ignored — the origin comes from the request, and the
variable is no longer read. An absent or invalid `ALLOW_REGISTER` value also closes registration, but
keeping the explicit `false` makes the upgrade intent clear. Existing MVP `uid=1` data must be
recovered with `auth:reset-user` below; opening self-registration would create a different user.

Set the new production authentication secret before the coordinated upgrade. Use an independent
random value of at least 32 characters; the existing `KEY_ENCRYPTION_SECRET` remains required and
must not be replaced as part of this upgrade.

    wrangler secret put BETTER_AUTH_SECRET

Then apply migrations and deploy the matching Worker as one coordinated upgrade:

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
- Upload HTTP 400/404/405/501 means the compatible endpoint cannot honor the Files contract, so that
  request falls back to inline bytes without saving a pointer. Authentication, throttling, network
  and other server failures still fail the turn instead of being disguised as missing capability.
- The daily cron (`0 3 * * *`) independently refreshes the catalog and deletes expired remote files.
  Cleanup reads indexed due pointers in pages, with bounded concurrency and a per-run limit.
  Success and HTTP 404/410 remove the pointer. Network errors, SDK-retryable errors (including HTTP
  408/409), HTTP 401/403/429 and server errors defer it by a day; unrecoverable references are logged
  without sensitive data and removed locally.
- Provider deletion, interface removal, key replacement and endpoint changes attempt affected
  remote deletes before changing the configuration. The operation proceeds despite remote failure;
  invalidated pointers are removed and old credentials are never retained for retries.
- Expired pointers never participate in generation. Cleanup never deletes R2 originals.

## File understanding

Settings → 全局服务模型 includes a file understanding model and an editable system instruction.
`analyze_file(path, question?)` delegates an uploaded or generated attachment to that model and
returns its detailed text analysis. The question travels separately from the system instruction.
The default instruction focuses on detailed visual descriptions and preserves transcribed text in
its original language. Existing custom prompts remain unchanged; the conversation naming default
uses the Task / Guidelines / Output Examples format.

Uploads accept PNG, JPEG, WebP, GIF, PDF, MP3, WAV, Ogg audio, FLAC, M4A, WebM audio/video, MP4 and
QuickTime video. Uploading is independent of model capabilities. PDFs appear as downloadable file
cards; audio and video use browser players with download links. Administrators configure allowed formats and the per-file size limit in `/admin/settings` (20 MiB by default). Every upload, including deduplication, checks the current policy; existing downloads remain available. Files are checked against their container signatures. No transcoding, frame extraction or local OCR is run.

`read_file` returns text directly. Supported non-text files follow a short tool receipt as a user
message containing `<read_file_result id="…">`, the file part, and the closing tag. The receipt's
`request_id` is stable across history replay. Tool results never contain file IDs, base64 or bytes.
Concurrent tool receipts finish before the file messages are appended.

Model modalities and protocol serialization capabilities both govern delivery. Unsupported user
attachments remain visible to the model as paths and MIME types; `read_file` reports an error.
Both suggest `analyze_file` only when that tool is enabled and its service model supports the file.
If neither model can read the file, the limitation is explicit. Historical attachments follow the
same checks when switching models. Analysis is an explicit tool call, not an automatic upload hook.
Audio/video travel inline; native Files references continue to be used for images and PDFs where
configured. Chat Completions audio encoding supports MP3/WAV; Anthropic and Responses support images/PDFs on these adapters; audio/video use Chat Completions or Vertex-compatible interfaces with matching model capabilities.
The configured provider still determines which formats its model accepts. DashScope endpoints receive audio as a complete Data URL rather than bare Base64, as required by their compatible API.

## Images

R2 is the only durable store for image bytes, uploaded and generated alike. A model's image output
is validated, hashed, written to R2 and reduced to an `attachment_id` *before* anything else sees
it, so D1 message JSON, the Durable Object's in-flight snapshot and every WebSocket frame carry the
id and nothing else — never base64, never raw bytes, never the provider's temporary URL. Identical
bytes dedupe by SHA-256. If any step fails, the reply ends as an error with its text intact and no
orphan row, no half-written R2 object and no file content anywhere.

## Plugin namespaces

A plugin owns three surfaces, and each has one place to live so two plugins can never collide:

    /api/plugins/<plugin-id>/...         HTTP routes, behind the session guard
    /api/plugins/<plugin-id>/<seg>/...   routes registered as public, carrying their own credential
    /settings/plugins/<plugin-id>        the plugin's configuration
    /settings/plugins/<plugin-id>/data   the plugin's own page, listed under 插件数据管理

Plugin ids are already unique — the client host throws when two plugins claim one tool id — so
namespacing by id makes a collision impossible rather than unlikely, and a URL says which plugin
answers it. Core resources keep `/api` and are not up for grabs.

A plugin page is declared in the manifest (`settingsEntry`) rather than derived from what the client
plugin registered: navigation has to be answerable without loading every plugin, and a shortcut that
appears only once its plugin happens to be loaded would come and go for reasons a reader cannot see.
Disabling a plugin removes the shortcut, never the page — its data outlives the switch, and that
data is exactly what someone reclaiming storage came for.

Server routes are registered through `ctx.pluginApi`, not by reaching for the Hono app: `register`
mounts a sub-app behind the session guard, `registerPublic` mounts one in front of it. Public is for
routes a cookie cannot reach — a sandboxed frame has an opaque origin, so its own subresource
requests are cross-site and arrive without one; such a route carries its own short-lived credential
instead.

A plugin's routes run on the Worker and its tools run inside the UserHub Durable Object, which are
different cordis roots. One plugin object injecting both would sit PENDING forever on whichever
service its side does not have, so the two halves are separate plugins — see
`src/plugins/workspace-files/server/`.

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
- **Generated images are read on demand.** The model receives their `/artifacts` paths when file or image tools are enabled; `read_file` delivers the image when supported, and `analyze_file` can provide a text description.
