# only-chat

Personal AI chat on Cloudflare Workers. Every device sees the same sessions and live streams.

- Four provider protocols: `openai-completions`, `openai-responses`, `anthropic`, `vertex`. A provider is just a protocol plus an endpoint and a key.
- Tree-shaped messages: editing or regenerating creates a sibling, with a branch switcher on the bubble.
- Text (markdown), pasted/dropped images (stored in R2), collapsible reasoning blocks.
- One WebSocket per user, held by a `UserHub` Durable Object. Generation runs server-side to completion, so any device can join, leave or reconnect mid-stream.
- Per-session system prompt and sampling params (`temperature`, `top_p`, `max_tokens`, `reasoning_effort`).

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

## Layout

    src/server/       Worker entry, cordis app, plugins (database, assets, llm, hub, api)
    src/server/plugins/llm/protocols/   one plugin per provider protocol
    src/server/plugins/hub/             UserHub DO: websocket hub, session commands, generation
    src/client/       Vue 3 SPA (pages, views, components, stores)
    src/shared/       zod schemas shared by both sides (models, parts, ws)
    migrations/       D1 migrations
    test/             vitest unit tests and worker-pool tests

Design notes: `docs/superpowers/specs/2026-09-05-only-chat-mvp-design.md`.

## Known gaps

- **Real Vertex is untested.** The `vertex` protocol (service-account JSON, `project` + `location`)
  is wired and covered by tests that build the model, but no live Google Vertex call has been made.
- **No authentication.** `user_id` is hard-coded to `1`. Cloudflare Access is the intended gate and
  is already configured in front of `chat.epb.wiki`.
- **The Vertex OAuth token is not cached.** Each generation re-signs the service-account JWT and
  exchanges it for an access token.
- **Feature plugins: mechanism only.** Settings carry a per-user plugin toggle map and the DO loads
  and disposes plugins from it, but no feature plugin ships with the MVP, so the page is empty.
