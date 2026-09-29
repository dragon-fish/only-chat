# Deployment

How to deploy only-chat to Cloudflare for the first time, and how to upgrade an existing deployment.

## First deployment

    wrangler d1 create only-chat-db   # paste database_id into wrangler.jsonc
    wrangler r2 bucket create only-chat-attachments
    wrangler kv namespace create KV   # paste its id into wrangler.jsonc's kv_namespaces
    wrangler secret put KEY_ENCRYPTION_SECRET
    wrangler secret put BETTER_AUTH_SECRET
    pnpm db:migrate:remote
    pnpm deploy

`wrangler.jsonc` already carries a `database_id` and a KV namespace id; replace both with the ones
you just created, and point `routes` at your own hostname. KV holds the model catalog and cached
model lists. The application's public origin is not
configured anywhere: authentication and the links tools hand out both derive it from the request
that arrived, so the route binding is what decides it. Generate independent random values for
`KEY_ENCRYPTION_SECRET` and `BETTER_AUTH_SECRET`; the latter must contain at least 32 characters.

`ALLOW_REGISTER` is a non-secret Worker variable and defaults to `false` in `wrangler.jsonc`. For a new deployment,
explicitly enable it only long enough to register the first account, which naturally receives
`uid=1` and fixed administrator privileges. Close it immediately afterward. `/admin/settings`
stores a D1 override with precedence over `ALLOW_REGISTER`; clearing that override restores the
environment value, or the default-closed behavior when the variable is absent.

Cloudflare Access in front of the Worker is optional. Leaving it enabled adds a second
authentication gate; removing it exposes the application's public login and registration-status
routes. If you are removing it from an existing deployment, do so only after the application login
for `uid=1` has been verified. All business REST routes, `/ws`, and attachment downloads still require
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
