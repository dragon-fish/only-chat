# Conversation Actions and Project Icons

## Scope

This change expands Project, Session, and assistant-message actions; adds current-branch Session forking and export; and adds reusable image cropping plus Project icons.

## Navigation menus

Project row menus use the existing shadcn-vue dropdown primitives in this order:

1. New chat → `/project/:id/new`
2. Project settings → `/project/:id/settings`
3. Separator
4. Delete Project

Session row menus use nested `DropdownMenuSub` groups:

1. Rename
2. Fork from here
3. Export
   - Markdown
   - JSON
4. Move to
   - Chats when the Session is currently in a Project
   - Every other Project
5. Separator
6. Delete conversation

The existing enlarged ellipsis hit target remains. Destructive confirmation and focus restoration remain unchanged.

Session and assistant-message fork actions use the Git fork icon and the label “从此处分叉”, leaving the copy icon available for copying message content. Assistant message footers add an always-visible ellipsis action containing this command. It is disabled while that assistant message is streaming.

## First-send focus preservation

The `/new` and `/c/:sessionId` URLs resolve through one aliased route record and one page component. Project-scoped `/project/:projectId/new` and `/project/:projectId/c/:sessionId` do the same. When the first Session is created, Vue Router updates the optional Session parameter while reusing the mounted ChatView and Composer DOM. The textarea never blurs, so touch keyboards are not dismissed and reopened.

## Session forking

Add a `session.fork` WebSocket command with:

- `request_id` required for this command;
- `session_id` identifying the source Session;
- `message_id` identifying the inclusive end of the copied path.

The server verifies that the Session belongs to the current user, the message belongs to the Session, and the selected message is not an in-flight shell. It walks parent links from `message_id` to the root and copies only that path in root-first order.

The new Session copies:

- `project_id`;
- `provider_id` and `model_id` overrides;
- `system_prompt`;
- `params`;
- the source title with ` 副本` appended.

Each copied Message retains its role, parts, generation provider/model, usage, terminal status, error, and original creation timestamp. New message IDs and parent IDs are allocated, and the new Session head points at the copied terminal message. Unselected branches are not copied.

If any message copy fails, the partially created Session is deleted before returning the error.

The server broadcasts the ordinary `session.created` event so every client sees the new Session, followed by `session.forked` containing the originating `request_id` and new Session ID. The client keeps a pending-request map and resolves only the matching request. A matching `error` event rejects it. On success, the initiating client navigates with `sessionPath(newSession)`.

The Session menu forks at `session.head_message_id`. An assistant message action forks at that message's ID.

## Current-branch export

Exports are client-side and operate on the active root-to-head path only. A Session opened from the sidebar loads its messages through the existing Session messages API before serialization.

Create a small exporter registry. Each exporter declares:

- stable ID;
- display name;
- file extension;
- MIME type;
- a serializer receiving Session metadata, optional Project metadata, current-path messages, and an attachment URL resolver.

Built-in exporters:

### Markdown

- Starts with the Session title and optional Project name.
- Renders user and assistant turns in order.
- Renders reasoning inside `<details>` blocks.
- Renders tool calls and results as fenced JSON.
- Renders images with absolute authenticated attachment URLs.
- Includes model and usage metadata in compact prose where available.

### JSON

- Includes an export format version.
- Includes the Session and optional Project snapshot.
- Includes complete current-path Message objects, Parts, provider metadata, and usage.
- Does not include unselected branches or credentials.

The registry is an internal extension boundary, not a full user-plugin runtime. Future formats can register another exporter without changing menu code.

Downloads use a sanitized title-based filename and an object URL that is revoked immediately after the browser accepts the download.

## Reusable image cropper

Cropping is generic infrastructure with no Project, upload, or API dependencies.

### Geometry core

A pure TypeScript module owns:

- crop rectangles and image/display coordinate conversion;
- initial centered maximum crop;
- moving within image bounds;
- eight-direction resizing;
- optional aspect-ratio locking;
- minimum crop dimensions;
- boundary clamping.

### ImageCropper component

The Vue component accepts:

- image Blob;
- optional aspect ratio;
- output width and height;
- minimum crop dimension;
- output MIME type and quality;
- rectangular or circular preview shape.

It uses Pointer Events for mouse, touch, and pen input. It owns and revokes image object URLs, removes every listener on unmount, and exposes an async crop operation that returns an encoded Blob plus its output dimensions.

The visual layer uses the existing theme tokens and shadcn-vue controls. It shows a dimmed outside region, crop boundary, resize handles, and optional circular preview guide.

Project icons configure the cropper as `1:1`, `200×200`, WebP, circular preview. Future profile avatars or composer image-cropping flows reuse the same component with different props.

## Project icons

Add one nullable Project column:

- `icon_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL`.

The shared Project schemas and Project create/update commands expose it with `undefined` meaning unchanged and `null` meaning clear.

The server validates:

- an attachment belongs to the current user;
- an icon attachment is an image with recorded dimensions of exactly 200×200;

Project settings provide:

- current icon preview;
- image selection that opens the cropper;
- cropped preview;
- clear action.

The cropped Blob uses the existing attachment check/upload API and SHA-256 deduplication. Saving Project settings writes the resulting attachment ID. Attachments are not eagerly deleted when icons change because content-addressed attachments can be shared by messages or other Projects.

`ProjectAvatar` renders in this order:

1. referenced image;
2. a leading Emoji grapheme parsed from the Project name;
3. grapheme-safe initials.

The stored name remains unchanged. Outside editing forms, a leading Emoji and its following whitespace are removed from the displayed title and rendered as the icon. Editing inputs always show the complete stored name. Initial extraction segments user-visible graphemes; Emoji surrogate pairs and joined multi-code-point emoji are never indexed with UTF-16 `word[0]`.

## Error handling

- Fork commands fail without creating or leaving a partial Session.
- Rename, move, fork, and Project icon saves use existing connection/error feedback.
- Export load/serialization failures show a toast and do not create an empty download.
- Invalid images, failed decoding, missing canvas contexts, and failed encoding surface an actionable cropper error.
- A missing icon attachment falls back to Emoji or initials without breaking Project navigation.

## Verification

Tests cover product-owned behavior:

- root-to-selected-message fork copying, parent remapping, configuration inheritance, rollback, and request correlation;
- Markdown and JSON serialization of the active branch;
- menu command/navigation wiring;
- pure crop geometry and fixed 200×200 Project-icon output;
- Project icon ownership and dimensions;
- Unicode-safe initial extraction.

Visual verification covers desktop and mobile menus, submenu placement, cropper pointer interaction, Project icon rendering, focus restoration, and responsive overlays. Third-party dropdown/dialog internals are not unit-tested.
