# Development


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

## Mock provider

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

Anything else — including a malformed directive — streams ordinary generated text. A file a tool
delivers arrives as a user message of its own; the mock skips those, so a script of several
`/tool_call` steps keeps going after a delivery.

The `mock-image` model serves Image Studio: each run downloads a placeholder photo from
`picsum.photos` at the requested size (the dev server needs direct internet access for this; it does
not go through a proxy). Directives do not apply to it. Pass `--user <id>`
to seed for a user other than `1`. The command is idempotent and local-only.

    pnpm typecheck                    # vue-tsc + both tsc projects
    pnpm test                         # vitest (unit + worker pool)
