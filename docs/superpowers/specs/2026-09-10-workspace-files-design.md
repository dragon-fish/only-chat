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

### Writing the descriptions

Tool descriptions are prompt surface, not documentation. Each one states, in this order: what the
tool does, when to reach for it, its limits, and what it returns. Beyond that:

- **Name the default budget.** "Reads up to 2,000 lines" tells the model what it is spending.
- **Steer toward the cheap path.** Say outright that a model which already knows the range should
  pass `offset` and `limit` instead of reading the whole file.
- **Describe the return shape.** Numbered lines, 1-based, so the model can cite positions back.
- **Separate the failure modes.** A missing file, an unavailable mount and an empty file are three
  different answers, and each must read as a fact rather than as a malfunction.
- **Include the negative instruction.** `list_files` never returns content; do not re-read a file
  that `write_file` just returned metadata for. Saying what *not* to do saves more tokens than
  saying what to do.
- **Point at the right tool.** `list_files` for discovery, `read_file` for content, `write_file` for
  a whole-file replacement — and state that partial edits are not supported in this release rather
  than letting the model discover it by failing.
- **Make the version protocol explicit.** Phrase it as a sequence the model can follow — read the
  file, keep the `version` it returned, pass it back as `expectedVersion` — not as a bare parameter
  requirement. Creating a new file omits it.

Wording is ours. The structure above is drawn from how Claude Code's own file tools are written.

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

#### Counting lines

`totalLines` is `content.split('\n').length`, with no trailing element discarded, and `0` for an
empty file. A trailing newline therefore produces a final empty line, which is real: it is what an
editor shows and what `lines.join('\n')` needs to reproduce the bytes exactly.

| Content | `totalLines` |
| --- | --- |
| `""` | 0 |
| `"a\nb"` | 2 |
| `"a\nb\n"` | 3 |
| `"a\nb\n\n"` | 4 |

This diverges from `wc -l` on purpose and matches Claude Code's Read tool, whose behaviour was
measured rather than assumed. Discarding the trailing empty line would make `"a\nb"` and `"a\nb\n"`
indistinguishable and break round-tripping. `totalLines` must equal exactly the number of lines
`offset`/`limit` can address, or `nextOffset` goes wrong at the boundary.

An empty file returns an explicit "file is empty" result rather than one blank line, so the model can
tell an empty file from a file holding a single newline.

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

- Writing over an existing path is allowed and `expectedVersion` is optional.
- Passing `expectedVersion` asserts what the file currently is; a mismatch returns `VERSION_CONFLICT`.
- Every success creates an immutable version and switches the logical pointer.
- The maximum file size is 1 MiB of valid UTF-8 text.

Refusing a write because the caller did not read first would be the expensive choice, not the safe
one. The content being written may have cost tens of thousands of tokens to produce, while the
version it displaces is never destroyed — it stays addressable and `restore_file` brings it back.
Protecting recoverable data by discarding unrecoverable work is the wrong trade, so a blind write
lands and the result reports what it displaced.

`expectedVersion` therefore stops being a requirement and becomes an optional guard: it is a claim
about the file's current state, and a false claim means someone else moved it, which is a real
conflict worth refusing.

### Replacing a version nobody read

A result distinguishes two kinds of overwrite, because they mean different things to the caller:

- It replaced the version this turn had read, or a version it wrote itself. Ordinary; the reply
  notes the displacement.
- It replaced a version written *after* this turn last read the file. The write went over content
  the caller never saw, so the reply says so explicitly and names the version to restore.

The distinction comes from the per-turn scratchpad in `ToolContext`: `read_file` records the version
it returned and `write_file` records the version it produced, so a version the caller wrote itself
counts as one it has seen. The scratchpad dies with the generation, so this can never leak between
conversations. The service does not participate — it reports which version was displaced, and
interpreting that against what this turn knows belongs to the tool.

### `restore_file`

```json
{ "path": "/project/report.md", "version": 3, "toPath": "/project/report-v3.md" }
```

Copies one stored version out under a name that is free. `toPath` must not exist: overwriting is the
thing restoring exists to undo, so a taken name returns `FILE_ALREADY_EXISTS` rather than being
resolved. The restored copy starts its own history at version 1 and the source file is untouched.

Restoring costs no storage. The bytes are already an attachment, so the operation is one pointer row
and one version row pointing at content that is already there.

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
tool/before-execute   waterfall over the input; a returned value short-circuits the default
tool/execute          waterfall over the result, after the default ran
tool/result           immutable completion notification
```

Names follow the convention already in use: `module/event` for something that just happened,
`module/before-event` for something about to happen, kebab-case, singular subject — matching the
existing `message/before-send`. There is no separate "around" event: a `tool/before-execute`
listener that returns a value replaces the default implementation, which is the same interception
with fewer concepts.

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

The file panel is its own modal, opened from the chat header and from the Project view — files are
not a setting, and burying them in a settings form makes them reachable only by opening a dialog
about something else.

Mount paths are the model's addressing scheme and are never shown to a reader. The panel groups
files under 当前会话 and 当前项目, each saying who can read them, and names a row by its path inside
that group.

The list shows size, line count, version, update time. Users can preview, download, or logically
delete a file, and take a whole group as one archive. Version history and rollback are not exposed
in the first release.

A model may legitimately write a page as several files — an HTML importing the stylesheet and
script beside it — so the archive preserves relative layout, and single-file downloads stay
available for anything else.

Preview shows source, highlighted by the same renderer the chat uses. Markdown opens rendered
instead — it is written to be read, and it goes through the chat's own `safe` HTML policy, so a
script tag or event handler never survives it and nothing has to be opted into. Rendering a *page*
is different, because a page runs: that is a plugin setting, and it starts off. When it is on, a file is served to a frame
sandboxed without `allow-same-origin`, under a short-lived ticket carried in the URL's directory
prefix: the frame's opaque origin means its own subresource requests are cross-site and arrive
without cookies, and the prefix is exactly what a relative `./style.css` keeps. Responses carry a
CSP sandbox so even a direct navigation lands in an opaque origin. The setting exists because none
of that changes the fact that the code was written by a model.

A finished assistant message ends with the files that turn produced — the first few, then a link to
the full panel. The tool cards above it are a log of calls; this is the outcome, which is usually
what the reader wanted. It is contributed by the plugin through a message-footer extension point,
not hard-coded into the message renderer.

Tool calls use plugin-owned cards:

- `list_files` summarizes the directory and returned count.
- `read_file` shows path, returned line range, and metadata; content is collapsed by default.
- `write_file` shows created/updated state, bytes, lines, and actions to open or download the file.

The file modal shows source text, path, current version, size, line count, update time, and provenance. Markdown, JSON, HTML, and other UTF-8 files are previewed as source. HTML is never executed in the first release.

## Projected Mounts

Beyond the two writable mounts, the VFS can expose read-only mounts that are *projections* of data
the app already owns — uploads attached to messages, generated images and other Artifacts.

A projection stores nothing of its own. The service derives its entries from `attachments`,
`messages` and `artifacts` at read time; no `workspace_files` row is created. This keeps the
dependency pointing the right way: the filesystem reads the core's data, and the core never learns
that a filesystem exists. It also makes lifecycle automatic — deleting the message deletes the
entry, with no reconciliation to drift — and it sidesteps the version model entirely, since a
projected entry has no `current_version` to compare and swap.

`write_file` to a projected mount is refused. Artifacts and Workspace Files stay separate as
described above: a projection is a view, not a transfer of ownership.

### Reading media

`read_file` is bounded by what the *current model* accepts, not by a hard-coded list of types:

- UTF-8 text is always readable, as numbered lines.
- A modality the model declares support for (image, PDF, audio) is returned as media, so the model
  sees it exactly as it would see a file the user attached.
- Anything else returns a plain statement that this model cannot read this kind of file. That is a
  fact the model can act on, not a failure.

This needs the model's declared input modalities in `ToolContext`; they are already resolved on
`models.metadata_resolved.modalities.input`.

**Media must not travel inside the tool result.** `LanguageModelV4ToolResultOutput` can carry media
only as base-64 (`{ type: 'media', data, mediaType }`) — there is no file-reference variant — so a
2 MiB image becomes ~2.7 MiB of request body, resent on every subsequent turn. The app already has
the cheaper path: `resolveAttachmentInputs` uploads an attachment through the provider's Files API
when the interface supports it, reuses the pointer, and falls back to inline only when it must.

So a media read returns metadata as its tool result and attaches the underlying attachment to the
assistant message as an image part, which puts it on the same transport as a user upload. Making a
tool able to contribute a message part rather than only a return value is what the `tool/execute`
waterfall is for.

## Errors and Security

Expected model-correctable failures return stable tool error values:

```text
INVALID_PATH
MOUNT_UNAVAILABLE
FILE_NOT_FOUND
FILE_ALREADY_EXISTS
VERSION_CONFLICT
VERSION_NOT_FOUND
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

- The four tools are owned by one built-in plugin and selected by default only for new Conversations when enabled.
- Project and Conversation mounts enforce ownership and remain distinguishable when empty or unavailable.
- Bytes live in attachments/R2; logical files and immutable versions live in D1.
- A write never destroys anything: a displaced version stays restorable, and a caller that named a version is told when that claim no longer holds.
- Read/list/write results include the agreed size, line, range, time, version, and truncation data.
- No result silently truncates content, exposes storage keys, or leaks another tenant's existence.
- Tool results and official hook modifications reaching the model are persisted and replayable.
- Project/Conversation lists, Tool cards, source preview, download, and human deletion work without executing HTML.
- Artifact Gallery behavior and schemas remain unchanged.
- Memory, Sandbox, Browser Run, pattern edit, model deletion, rollback UI, and dynamic third-party plugin execution remain out of scope.
