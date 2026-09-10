# Workspace Files and Plugin Extension Design

## Scope

The first release adds a minimal persistent virtual filesystem (VFS) as a built-in plugin. It supports UTF-8 text through `list_files`, `read_file`, and `write_file`.

Memory, sandbox execution, browser automation, binary authoring, model-facing delete, version rollback, and an independent file-management application are out of scope.

Artifacts and workspace files remain separate:

- An Artifact is an immutable output of one AI or tool run, such as an image, video, audio file, rendered report, or archive.
- A Workspace File is a named, mutable pointer whose writes create immutable versions.
- Both reuse `attachments` and R2. One attachment may be referenced by both an Artifact and a Workspace File Version.
- Writing a workspace file does not create an Artifact. A later explicit publish/export operation may snapshot a file version as one.

## Virtual Paths

The VFS exposes fixed top-level mounts:

```text
/project/**       Files shared by conversations in the current Project
/conversation/**  Files private to the current Conversation
```

Plugins and models cannot create, delete, or rename top-level mounts. Intermediate directories are synthesized from file paths and need no database rows.

`/conversation` is available for every persisted Conversation. `/project` is available only when the Conversation belongs to a Project. `list_files("/")` always returns both defined mounts so the model can distinguish `empty` from `unavailable`:

```json
{
  "path": "/",
  "entries": [
    {
      "path": "/project",
      "type": "mount",
      "status": "unavailable",
      "description": "Files shared by conversations in the current project"
    },
    {
      "path": "/conversation",
      "type": "mount",
      "status": "empty",
      "description": "Files private to the current conversation"
    }
  ]
}
```

All paths are absolute VFS paths. Resolution rejects unknown mounts, empty relative paths, `.` or `..` segments, repeated separators, NUL bytes, and paths beyond database limits. Requests never accept a user-supplied Project, Conversation, or user ID; those identities come from the runtime.

## Storage

`workspace_files` stores the current logical pointer:

```text
id
user_id
project_id nullable
conversation_id nullable
relative_path
current_version
created_at
updated_at
deleted_at nullable
```

Exactly one of `project_id` and `conversation_id` is present. Active paths are unique within their scope. Project deletion cascades through Project files; Conversation deletion cascades through Conversation files.

`workspace_file_versions` stores immutable versions:

```text
id
file_id
version
attachment_id
mime
file_size
total_lines
source_conversation_id nullable
source_message_id nullable
tool_call_id nullable
created_at
```

Versions are unique by `(file_id, version)`. Deleting a source Conversation or Message clears provenance on Project files without deleting the version. Deleting a Workspace File removes logical visibility but retains versions until attachment reference cleanup can reclaim unreferenced content.

Content uses existing per-user SHA-256 attachment deduplication and R2. Attachment `origin` does not define file semantics because an existing upload or generated blob may later become a workspace file.

For an update, D1 creates the new version and advances `current_version` only when it still equals `expectedVersion`. This CAS is atomic. A losing writer receives `VERSION_CONFLICT` and never overwrites the winner.

## Workspace Files Service

The feature is one capability with explicit roles:

```text
WorkspaceFiles Service Definition
├── D1 + R2 Service Provider
├── list/read/write Tool Consumer
└── Client file-panel and Tool-card Consumers
```

The service owns path resolution, authorization, stable directory listing, bounded reads, content publication, version CAS, logical deletion, and attachment references. Tools and HTTP routes call this service instead of querying D1 or R2 directly.

The core publication method accepts authenticated bytes, metadata, and provenance. A later Sandbox, Browser Run, generator, or import flow can publish through the same method without duplicating VFS rules.

## Tool Contracts

### `list_files`

```json
{ "path": "/", "limit": 100, "cursor": null }
```

The tool lists direct children in stable name order and never reads file content. Results include logical directories and files with `path`, `type`, `fileSize`, `totalLines`, `updatedAt`, and `version` where applicable. More than `limit` entries returns `truncated: true` and `nextCursor`.

### `read_file`

Input uses 1-based line positions:

```json
{ "path": "/project/report.md", "offset": 1, "limit": 50 }
```

The result is structured and contains model-facing numbered text:

```json
{
  "path": "/project/report.md",
  "content": "1 | # Report\n2 | Content",
  "startLine": 1,
  "returnedLines": 2,
  "totalLines": 123,
  "fileSize": 1234,
  "updatedAt": "2026-09-10T12:34:00Z",
  "version": 7,
  "truncated": true,
  "nextOffset": 3
}
```

The default limit is 2,000 lines. One model-visible result is limited to 100 KiB. A whole-file request beyond the bound asks the model to use `offset` and `limit`; an explicitly selected range that still exceeds it asks for a smaller range. No content is silently omitted. A session-local optimization may return `unchanged: true` when the same path, version, and range was already delivered; correctness does not depend on this cache surviving a restart.

### `write_file`

`write_file` creates or fully replaces UTF-8 text. It is not a pattern edit tool.

```json
{
  "path": "/project/report.md",
  "content": "# Report\nContent",
  "expectedVersion": 7
}
```

- Creating a missing path omits `expectedVersion`.
- Updating an existing path requires the version returned by `read_file` or `list_files`.
- A create racing with another create returns `FILE_ALREADY_EXISTS`.
- A stale update returns `VERSION_CONFLICT`.
- Every success creates an immutable version and switches the logical pointer.
- The maximum file size is 1 MiB of valid UTF-8 text.

Success returns `path`, `operation` (`created` or `updated`), `fileSize`, `totalLines`, `version`, `updatedAt`, and a concise message such as `Saved 1,234 bytes, 42 lines`.

The first release has no model-facing `delete_file` or `edit_file`. A future exact-pattern edit reuses the same service and `expectedVersion` CAS.

## Plugin Runtime and Cordis Events

Only-chat retains Cordis semantics: events receive live objects by reference, and plugin authors may mutate them, wrap default behavior, call services directly, or deliberately short-circuit a waterfall. The framework enforces storage integrity and tenant ownership, not plugin policy.

Registrations are reversible Cordis effects. Built-in plugins are discovered at build time from:

```text
src/plugins/*/manifest.ts
src/plugins/*/server/worker.ts
src/plugins/*/server/hub.ts
src/plugins/*/client/index.ts
```

Manifests declare owned tools separately from default selection:

```ts
tools: [
  { id: 'list_files', name: '列出文件', defaultEnabled: true },
  { id: 'read_file', name: '读取文件', defaultEnabled: true },
  { id: 'write_file', name: '写入文件', defaultEnabled: true },
]
```

Enabling the plugin seeds these tools only when a new Conversation captures its tool snapshot. Existing Conversations do not change automatically.

Tool definitions receive the current Agent runtime after the Assistant shell exists:

```ts
interface ToolRuntimeContext {
  userId: number
  conversationId: number
  projectId: number | null
  assistantMessageId: number
  db: DB
  assets: Assets
  signal: AbortSignal
}
```

The tool pipeline exposes:

```text
tools/pre-execute     waterfall
tools/execute         waterfall around the default implementation
tools/post-execute    waterfall
tools/result          immutable completion notification
```

Lifecycle hooks expose mutable sessions at stable persistence points:

```text
conversation/before-create
message/before-send
generation/before-send
assistant/before-finalize
```

After each before hook, the host persists changed Conversation and Message fields before the next externally visible action. A plugin may modify prior context; the host persists those changes and broadcasts a resync. This invalidates an existing provider prefix once. The framework permits it, while official plugins avoid rewriting history.

Official guidance is append-only: establish system context and tool IDs at Conversation creation, append new model-visible context as durable messages, keep stable tool IDs/schema versions, and avoid changing prior messages. Model-visible content must be reconstructable from persisted Conversation, Message, Tool Result, or plugin state. Ephemeral direct tool injection remains possible but has no prefix-stability guarantee.

Worker plugins may register private REST routes through an API registry. Client plugins may register Tool cards and required UI contributions through a Slot registry:

```text
tool.call.view
project.settings.files
conversation.settings.files
```

Host/Client plugin communication uses authenticated, plugin-private JSON RPC. The first release does not support downloading or executing untrusted third-party plugin JavaScript.

## Human UI

Project settings receives a Files tab for `/project`. Conversation settings receives a Files section for `/conversation` and may show the current Project mount. Both use one reusable file-list component.

The list shows path, size, line count, update time, and latest source. Users can open, download, or logically delete a file. Version history and rollback are not exposed in the first release.

Tool calls use plugin-owned cards:

- `list_files` summarizes the directory and returned count.
- `read_file` shows path, returned line range, and metadata; content is collapsed by default.
- `write_file` shows created/updated state, bytes, lines, and actions to open or download the file.

The file modal shows source text, path, current version, size, line count, update time, and provenance. Markdown, JSON, HTML, and other UTF-8 files are previewed as source. HTML is never executed in the first release.

## Errors and Security

Expected model-correctable failures return stable tool error values:

```text
INVALID_PATH
MOUNT_UNAVAILABLE
FILE_NOT_FOUND
FILE_ALREADY_EXISTS
VERSION_REQUIRED
VERSION_CONFLICT
FILE_TOO_LARGE
INVALID_UTF8
READ_RANGE_TOO_LARGE
```

Authorization, foreign-scope references, impossible database state, and storage failures fail tool execution. Errors never expose R2 keys, SQL, credentials, or another tenant's existence.

Every operation starts from the authenticated user and verifies Conversation/Project relationships. Download and preview routes repeat ownership checks. Attachment garbage collection treats Workspace File Versions as references.

Synchronous VFS operations are bounded work required to form the tool result. Future browser, sandbox, conversion, or bulk operations that must survive disconnects are handed to a Queue or Workflow and publish a version only after staging succeeds.

## Research Notes

- Claude Code validates read ranges, includes line metadata, renders numbered content, bounds large reads, detects unchanged reads, and protects full-file writes against changes since the last read.
- OpenAI Codex makes tool-output byte/token limits and omission explicit; large output must not disappear silently.
- DeepSeek Harness implements capabilities as Cordis plugins, uses reversible effects and scoped Service/Provider/Consumer roles, exposes waterfall interception, and requires every model-visible input to be reconstructable from its durable session log. Its AGENTS.md support is an append-only context plugin rather than agent-loop special handling.
- Cloudflare Sandbox SDK can provide isolated Linux execution and Browser Run can provide browser automation. Their transient files are not the Only-chat source of truth; future integrations publish selected bytes into Workspace Files. Long-running work uses Queues or Workflows.

## Acceptance Criteria

- The three tools are owned by one built-in plugin and selected by default only for new Conversations when enabled.
- Project and Conversation mounts enforce ownership and remain distinguishable when empty or unavailable.
- Bytes live in attachments/R2; logical files and immutable versions live in D1.
- Concurrent writes cannot silently overwrite a newer version.
- Read/list/write results include the agreed size, line, range, time, version, and truncation data.
- No result silently truncates content, exposes storage keys, or leaks another tenant's existence.
- Tool results and official hook modifications reaching the model are persisted and replayable.
- Project/Conversation lists, Tool cards, source preview, download, and human deletion work without executing HTML.
- Artifact Gallery behavior and schemas remain unchanged.
- Memory, Sandbox, Browser Run, pattern edit, model deletion, rollback UI, and dynamic third-party plugin execution remain out of scope.
