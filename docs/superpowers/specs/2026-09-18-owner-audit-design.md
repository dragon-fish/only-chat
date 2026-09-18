# Owner Audit

## Scope

The site owner (user id `1`) gets two read-only, site-wide listings — every account's
conversations and every account's providers — so that helping a non-technical user no longer means
querying D1 by hand. Nothing in this feature writes to another account's data, and no ordinary
`admin` can reach it.

The shape follows MediaWiki special pages: think Special:Conversations and Special:Providers. Each
is one filter form over one table, every filter lives in the URL, paging is newer/older, and a
cell that names a user is a link that filters by that user.

Separately, starting a model catalog refresh becomes admin-only.

Out of scope: an audit log table, notifying the audited user, viewing in-flight generation state
held in the audited user's Durable Object, viewing projects, plugin data or workspace files.

## Who may audit

| Condition | Result |
| --- | --- |
| `ENABLE_AUDIT` is not exactly `"true"` | every audit data route answers 404, the client shows no entry |
| caller is not the owner (including role `admin`) | 403 |
| caller is the owner | allowed |

- `src/shared/auth.ts` has `OWNER_USER_ID = '1'` and `isAuthOwner(user)`; `isAuthAdmin`,
  `adminUserIds` and the owner badge in `admin-users.vue` use them.
- `src/server/plugins/api/auth.ts` has `requireOwner`, which runs after `requireAuth`.
- `ENABLE_AUDIT` is read fail-closed: only `true` (JSON boolean or the string) enables it.
  `wrangler.jsonc` declares it `false` next to `ALLOW_REGISTER`, so every deployment, a fork
  included, starts with it off; `.dev.vars` overrides it locally. A declared var overrides the
  dashboard on each deploy, so a deployment enables it in its Workers Builds deploy command
  (`wrangler deploy --var ENABLE_AUDIT:true`).

## Server

`src/server/plugins/api/audit.ts`, all `GET`, all behind the `/api/*` session guard.

| Route | Response |
| --- | --- |
| `/admin/audit/conversations` | page of `AuditConversationRow` |
| `/admin/audit/conversations/:id` | `{ conversation, owner, messages, config }` — every message of every branch, plus the configuration the next turn would use |
| `/admin/audit/providers` | page of `AuditProviderRow` |
| `/admin/audit/attachments/:id` | any account's attachment bytes, served by the shared `serveAttachment` |

Every route passes the enabled gate (404) and then `requireOwner` (403), and logs one
line `console.log('audit', { viewer, path })` where `path` includes the query string. No response
content is logged.

### Listing parameters

Shared by both listings, all optional; an invalid value is a 400.

| Param | Meaning | Default |
| --- | --- | --- |
| `user` | owner user id | all users |
| `limit` | one of 50, 100, 250, 500 | 50 |
| `after`, `before` | opaque cursor from a previous page | first page |
| `sort` | conversations: `id`, `created`, `active` (`updated_at`); providers: `id` only | `id` |
| `dir` | `asc`, `desc` | `desc` |

Conversations also take `since` / `until`: epoch ms bounds on `updated_at` (most recent activity),
inclusive / exclusive.

A page is `{ rows, next, prev }`. Paging is keyset on `(sort column, id)`: `after` continues in the
sort direction, `before` walks back, and rows always come back in sort order. `next` is present when
more rows follow, `prev` when the request carried a cursor.

### Conversation rows

`id, title, kind, archived, created_at, updated_at, owner { id, name, email },
model { provider_id, model_id, name } | null, tokens { input, output }`.

- `model` produced the latest assistant message, in any branch — what actually ran, since the
  conversation's own `model_id` is only an override and usually null. `name` comes from that
  model's resolved metadata when the row still exists.
- `tokens` sums `usage.prompt` and `usage.completion` over every message of every branch. Input
  counts the whole context again on each turn.
- Archived conversations are listed and flagged.

`config` is `resolveEffectiveConfig` over the conversation and its Project, the resolution a
generation runs: the system prompt is the Project prompt and the conversation prompt joined, the
params are the Project's with the conversation's over them, plus the model and the Project name. A
model or reasoning picked for a single turn is never stored, so it cannot appear.

### Provider rows

`id, name, enabled, has_key, created_at, owner { id, name, email }, default_interface_id,
interfaces { id, protocol, base_url }[], models { id, model_id, name }[]` (enabled models only).
Columns are selected explicitly; `api_key` is never selected, `has_key` is `api_key IS NOT NULL`.

## Client

- Whether to show the pages comes from `GET /api/site-config`, the one request that carries every
  site-wide setting (`allowRegister` today). It is public, and adds `audit` only when the session
  is the owner's. The client loads it once per session into a store (`stores/site-config.ts`).
- Entry: an 「审计」 group with 「全站会话」 and 「全站供应商」, shown only to the owner while
  `audit` is true. The settings sidebar and the `/settings` landing page render the same table of
  contents, `stores/settings-nav.ts`, as Special:SpecialPages is for a wiki. The row menu in
  `admin-users.vue` links to `/admin/audit/conversations?user=<id>`.
- Router guard: `/admin/audit/**` requires `isAuthOwner`.
- Both listing pages read and write the URL query. The form has `user` (a select filled from the
  admin user list) and, for conversations, `since` / `until` as `YYYY-MM-DD` local dates (converted
  to epoch ms for the API), `sort` and `dir`. `limit` is a row of links 50 / 100 / 250 / 500.
  上一页 / 下一页 carry the cursor in the URL. The two pages do not link to each other.
- `/admin/audit/conversations` (`views/admin-audit-conversations.vue`): columns ID, 标题, 所有者 (links
  to `?user=`), 类型, 模型, 创建时间, 最近活跃, token (输入 / 输出). Archived rows carry a badge.
  The title opens a read-only preview dialog (`components/audit-conversation-preview.vue`) of the
  branch ending at the conversation's `head_message_id`, with an info button beside the close button that opens `config` in a second dialog. The open preview is `?preview=<id>`: back
  closes it, the link can be shared, and it does not reload the listing.
- `/admin/audit/providers` (`views/admin-audit-providers.vue`): columns ID, 名称, 所有者 (links to
  `?user=`), 状态 (启用 / 密钥), 默认接口, 已启用模型 as 「first three 等共计 n 个」. The name opens a
  details dialog with every interface and every enabled model.

### Read-only rendering

`MessageList` / `MessageItem` and the tool renderers read the sync store and the viewer's own
config. The preview provides an injection (`src/client/lib/audit-context.ts`) holding:

- `attachmentUrl(id)` — used wherever a message component shows an attachment;
- `resolveModel({ provider_id, model_id })` — resolves against the conversation owner's providers,
  used by `MessageList` instead of `config.modelFor`.

When the injection is present, components render no write affordance: no edit, regenerate, branch
switcher, fork, tool continue, or human-tool answer controls, and tool renderers are shown busy.
The audit view sends nothing over the owner's WebSocket.

A message still `streaming` in D1 is shown as stored; its live state lives in the owner's Durable
Object and is not fetched.

## Model catalog refresh

- `POST /model-catalog/refresh` and `GET /model-catalog/refresh/:instanceId` require an admin.
- `catalog-refresh-status.vue` hides the refresh button unless `isAuthAdmin(auth.authUser)`; the
  version and last-success lines stay visible to everyone.

## Tests

Worker tests:

- audit disabled: owner gets 404 on data routes and `audit: false` from site config;
- site config carries `audit` for the owner only, never for an admin, a user or a guest;
- audit enabled: a role-`admin` user and a plain user get 403 on every audit route;
- the provider listing spans users, filters by user, and contains neither the stored ciphertext nor
  an `api_key` field;
- the conversation listing spans users, filters by user and activity time, reports the latest
  assistant model and token sums, includes archived rows, and pages forward and back without gaps
  or repeats;
- invalid listing parameters are a 400;
- owner reads any account's transcript and attachment;
- a plain user gets 403 from `POST /model-catalog/refresh`.

Unit tests: `MessageItem` under the audit injection renders none of the write controls; the audit
entries appear only for the owner with audit enabled.
