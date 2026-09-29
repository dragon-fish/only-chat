# Architecture

## Naming

Authentication state is an `AuthSession`; a chat is a `Conversation`. D1 stores chats in
`conversations` and links each message through `messages.conversation_id`. Initial reads use
`GET /api/conversations` and `GET /api/conversations/:id/messages`, scoped to the authenticated
user. Conversation writes remain serialized by that user's `UserHub` over `/ws`; commands and
events use `conversation_id`, `conversation.update`, `conversation.delete`, `conversation.fork`,
and `conversation.created` / `conversation.updated` / `conversation.deleted` /
`conversation.forked`. The browser cannot select a user ID: the Worker derives it from the Better
Auth login before routing to the per-user Durable Object.

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

A plugin that cannot work without another says so in its manifest (`requires`), and its server half
injects that plugin's service. The two are checked against each other by a test. Enabling a plugin
enables what it requires and disabling one disables what requires it; a conversation's tool
selection follows the same rule, and each generation adds required tools rather than trusting a
stored selection. Stored switches count a requirement as on, so settings saved before a plugin gained
one keep working.

A plugin's routes run on the Worker and its tools run inside the UserHub Durable Object, which are
different cordis roots. One plugin object injecting both would sit PENDING forever on whichever
service its side does not have, so the two halves are separate plugins — see
`src/plugins/workspace-files/server/`.

## Image backends

An image run (`artifact_runs`) normally targets one of the user's provider models. A plugin can
supply images another way by registering an `imageBackends` entry under its own protocol name; runs
it creates carry that name in `interface_protocol`, no provider, and whatever the backend needs in
`backend_state`. `executeImageRun` hands such a run to the backend for bytes and keeps everything
after that — validation, R2, the gallery, the task notification — on the shared path. The backend
names the plugin the notification is attributed to and may word its text.

`imageBackends` lives on the Worker side as well as the workflow side: cancelling a tool run from the
API sends its notification from the Worker. The ComfyUI plugin is the one backend today; it submits
in the tool call, so ComfyUI's validation errors reach the model at once, and only the wait for the
images runs in the Workflow.

## Source layout

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
`docs/superpowers/specs/2026-09-28-conversation-files-design.md` defines assets, file references,
binary workspace files and file understanding.
`docs/superpowers/specs/2026-09-29-mcp-client-design.md` defines the remote MCP client plugin.
`docs/superpowers/specs/2026-09-29-comfyui-plugin-design.md` defines the ComfyUI plugin and image
backends.
