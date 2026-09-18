# Owner Audit

## Scope

The site owner (user id `1`) gets a read-only view of another account's provider configuration and
conversations, so that helping a non-technical user no longer means querying D1 by hand. Nothing in
this feature writes to another account's data, and no ordinary `admin` can reach it.

Separately, starting a model catalog refresh becomes admin-only.

Out of scope: an audit log table, notifying the audited user, viewing in-flight generation state
held in the audited user's Durable Object, viewing projects, plugin data or workspace files.

## Who may audit

| Condition | Result |
| --- | --- |
| `ENABLE_AUDIT` is not exactly `"true"` | every audit route answers 404, the client shows no entry |
| caller is not the owner (including role `admin`) | 403 |
| caller is the owner | allowed |

- `src/shared/auth.ts` gains `OWNER_USER_ID = '1'` and `isAuthOwner(user)`. `isAuthAdmin`,
  `adminUserIds` in `src/server/plugins/auth/index.ts` and the owner badge in `admin-users.vue` use
  them instead of the `'1'` literal.
- `src/server/plugins/api/auth.ts` gains `requireOwner`, which runs after `requireAuth` and checks
  `isAuthOwner(c.get('authSession').user)`.
- `ENABLE_AUDIT` is read fail-closed: only the string `"true"` enables it. It is **not** declared in
  `wrangler.jsonc` `vars`, because a deploy would overwrite a dashboard value with the declared
  default. Production sets it with `wrangler secret put ENABLE_AUDIT`; local dev sets it in
  `.dev.vars`. `.dev.vars.example` documents it as `ENABLE_AUDIT="false"`.

## Server

New file `src/server/plugins/api/audit.ts`, mounted in `ApiPlugin` like the other route files. All
routes are `GET`, all sit behind `requireAuth` (the existing `/api/*` guard) and then an audit gate
that applies the table above.

| Route | Response |
| --- | --- |
| `/admin/audit/status` | `{ enabled: boolean }` — the only audit route that answers when disabled; still owner-only |
| `/admin/audit/users/:uid/providers` | `AuditProvider[]` (below) |
| `/admin/audit/users/:uid/conversations?kind=chat\|image` | `listConversations(db, uid, kind)` |
| `/admin/audit/users/:uid/conversations/:id/messages` | `{ conversation, messages }` from `getConversation` + `listMessages`, both scoped by `uid`; 404 when the conversation is not `uid`'s |
| `/admin/audit/users/:uid/attachments/:id` | the attachment bytes, scoped by `uid` |

`AuditProvider` (interface in `src/shared/api.ts`):

```ts
{
  id, name, enabled, has_key: boolean,
  default_interface_id,
  interfaces: { id, protocol, base_url }[],
  models: { id, model_id, interface_id, name, family, lab_id }[]   // enabled models only
}
```

The provider query selects these columns explicitly. `api_key` is never selected; `has_key` is
computed in SQL as `api_key IS NOT NULL`.

The attachment route shares its serving code with `GET /attachments/:id`: the part that turns an
`attachments` row into a response (ETag, 304, R2 stream, headers) moves into a function both routes
call. Only the row lookup differs.

Every audit request that reaches a handler logs one line:
`console.log('audit', { viewer, target, path })` — no response content.

Path ids go through the existing `parseId`; an invalid id is a 404.

## Client

- `src/client/lib/api.ts` gains the audit calls and `auditAttachmentUrl(uid, id)`.
- `admin-users.vue`: when the viewer is the owner and `/admin/audit/status` says enabled, each other
  user's row menu gets an 「审计（只读）」 item linking to `/admin/audit/:userId`.
- Router guard: `/admin/audit/**` requires `isAuthOwner`.
- `pages/admin/audit/[userId]/index.vue` → `views/admin-audit-user.vue`: two tabs.
  - 供应商: one read-only card per provider — name, enabled, key present or not, interfaces
    (protocol + base URL, default marked), enabled models.
  - 会话: chat / image toggle, list of conversations (title, updated time) linking to the transcript.
- `pages/admin/audit/[userId]/c/[conversationId].vue` → `views/admin-audit-conversation.vue`: the
  transcript of the branch ending at the conversation's `head_message_id`, rendered with
  `MessageList`.

### Read-only rendering

`MessageList` / `MessageItem` and the tool renderers read the sync store and the viewer's own
config. The audit view provides an injection (`src/client/lib/audit-context.ts`) holding:

- `attachmentUrl(id)` — used wherever a component currently calls `api.attachmentUrl`;
- `resolveModel({ provider_id, model_id })` — resolves against the audited user's providers, used
  by `MessageList` instead of `config.modelFor`.

When the injection is present, components render no write affordance: no edit, regenerate, branch
switcher, fork, tool continue, or human-tool answer controls, and tool renderers are shown busy.
The audit view sends nothing over the owner's WebSocket.

A message still `streaming` in D1 is shown as stored; its live state lives in the audited user's
Durable Object and is not fetched.

## Model catalog refresh

- `POST /model-catalog/refresh` and `GET /model-catalog/refresh/:instanceId` get `requireAdmin`.
- `catalog-refresh-status.vue` hides the refresh button unless `isAuthAdmin(auth.authUser)`; the
  version and last-success lines stay visible to everyone.

## Tests

Worker tests:

- audit disabled: owner gets 404 on data routes and `{ enabled: false }` from status;
- audit enabled: a role-`admin` user and a plain user get 403 on every audit route;
- owner reads another user's providers, and the serialized response contains neither the stored
  ciphertext nor an `api_key` field;
- owner reads another user's conversation list, messages and an attachment;
- a conversation or attachment belonging to a different user than `:uid` is a 404;
- a plain user gets 403 from `POST /model-catalog/refresh`.

Unit test: `MessageItem` under the audit injection renders none of the write controls.
