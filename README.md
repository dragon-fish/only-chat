# only-chat

Personal AI chat on Cloudflare Workers. Every device sees the same sessions and live streams.

- Five provider protocols: `openai-completions`, `openai-responses`, `anthropic`, `vertex`,
  `vertex-compatible`. A provider is a protocol plus an endpoint and a key.
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

Then open `/settings/providers`, add a provider (from a preset or blank), paste a base URL and
API key, add a model, and start a chat.

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

## Providers

### Google: two separate protocols

`vertex` — **real Google Vertex AI**. Authenticates with a service-account JSON, pasted whole into
the API Key field, plus a Project and a Location under Extra:

    服务账号 JSON   {"client_email": "...", "private_key": "-----BEGIN PRIVATE KEY-----\n...", "private_key_id": "..."}
    Project        my-gcp-project
    Location       us-central1  (or global)

Project and Location appear on the edit page only for this protocol and are stored in the
provider's `extra`. The Base URL field is still filled in, but the `vertex` protocol ignores it —
the SDK derives the endpoint from Project and Location.

`vertex-compatible` — **a Vertex-shaped gateway that is not Google**. Takes an ordinary Base URL and
a plain API key sent as `Authorization: Bearer <key>`; Google's own `x-goog-api-key` header is
stripped. Requests are addressed as `{base_url}/v1/publishers/{publisher}/models/{model}`, so model
ids are entered as **`{publisher}/{model}`** (for example `google/gemini-3-pro-preview`). Only the
first slash separates the two halves, so a model name containing slashes survives intact.

Neither Google protocol can import models remotely. A Vertex-style gateway keeps its catalogue on a
different base than the one generation uses, and guessing at it would be wrong, so **"从 /models
拉取" is disabled for both and model ids are entered by hand**.

### Model capabilities are declared, never inferred

`vision`, `reasoning`, `tools`, `reasoning_can_disable`, `reasoning_efforts` and `image_output` are
set per model on the provider edit page. Nothing is guessed from a model id.

- `reasoning` gates the whole reasoning control. `reasoning_can_disable` decides whether an explicit
  "off" is ever sent — a model that cannot be turned off simply receives no reasoning field.
- `reasoning_efforts` is a **restriction, not a menu**: an empty or absent list means *undeclared*,
  which is unrestricted, and every strength stays selectable. Declare levels only to narrow them.
- `image_output` is what asks a Gemini model for the image modality.

Reasoning strength itself is three-state everywhere: absent means *inherit* from the Project,
`null` means *explicit Auto* (reasoning on, no effort sent), and a string is an explicit strength.

### `native_files`: provider file pointers

Off for a blank provider; only the OpenAI preset, which is known to implement one, ships with it on.
Turn it on **only for an endpoint that really implements a Files API with upload-time expiry** — an
OpenAI-compatible gateway that does not implement `/files` will fail the turn with the auth,
rate-limit or server error it got, rather than quietly falling back to inline bytes. With it off,
image bytes are inlined into every request, which is correct but re-sends the same image on every
turn of a long chat.

With it on:

- Each image is uploaded once per provider and the pointer is stored keyed by
  `(attachment_id, provider_id)` — no session and no model. Switching a chat A → B → A reuses A's
  original pointer instead of minting a second one.
- Uploads ask for a **seven-day** expiry. If the provider reports its own `expires_at`, that value is
  what gets stored; otherwise the local pointer dies on the deadline the upload asked for.
- A **daily cron** (`0 3 * * *`) deletes lapsed pointer rows from D1 and nothing else. It never calls
  a provider DELETE — the remote copy expires on its own — and never touches R2. A failed run is safe
  to retry, because generation already refuses an expired pointer whether or not the sweep ran.

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

## Known gaps

- **Real Vertex is untested.** Both Google protocols are wired and covered by tests that build the
  model, but no live Google call has been made from this deployment.
- **No authentication.** `user_id` is hard-coded to `1`. Cloudflare Access is the intended gate and
  is already configured in front of `chat.epb.wiki`.
- **The Vertex OAuth token is not cached.** Each generation re-signs the service-account JWT and
  exchanges it for an access token.
- **Feature plugins: mechanism reserved, not wired up.** Settings carry a per-user plugin toggle
  map and there's a toggle UI for it, but the DO does not yet load or dispose feature plugins from
  that map, and no feature plugin ships yet, so the page is empty.
- **Anthropic model listing only reads the first page.** `fetch-models` calls `GET /models` once
  and ignores `has_more`/pagination, so an Anthropic account with more models than fit on one page
  will only import the first page's worth.
- **Generated images are not replayed to the model.** They are stored, broadcast and rendered, but
  a later turn does not send them back as context.
