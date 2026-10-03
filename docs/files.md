# Files


The core is plain chat: it takes attachments and hands them to the model, and never puts tool
context into a conversation. Naming files, reading them on demand and working on them come from
plugins — `file_reader`, and the plugins that require it.

## Uploads

Chat uploads accept PNG, JPEG, WebP, GIF, PDF, MP3, WAV, Ogg audio, FLAC, M4A, WebM audio/video,
MP4 and QuickTime video, and text: plain text, Markdown, HTML, CSS, JavaScript, JSON, CSV, and
source files by extension (`.py`, `.ts`, `.vue`, …, all stored as `text/plain` with the name keeping
the extension). Uploading is independent of model capabilities.

Text is stored as UTF-8 only. A file in another encoding is converted in the browser before it is
uploaded: `chardet` (loaded only when needed) guesses the encoding from the first 64 KiB, and a
guess with confidence of at least 50 that the browser can decode is converted; anything else is
refused. The file part records the original encoding in `source_encoding`, and the composer and the
message's file card say so in orange — a download is the stored UTF-8, not the bytes that were
picked. The server accepts nothing but valid UTF-8.

PDFs and text appear as file cards with open and download links; audio and video use browser
players. The attachment route answers `Range` requests (`206`), which media seeking needs, and serves
every text type as sandboxed `text/plain`, so an uploaded page is shown and never run on this origin.
An attachment row has no filename, so download links pass `?download=<name>` and the route answers
with `Content-Disposition: attachment` — download managers re-request the link and ignore
`<a download>`.

Administrators configure the allowed formats and the per-file size limit in `/admin/settings`:
every supported format and 20 MiB by default, 50 MiB at most, and an empty format list turns chat
uploads off. The policy covers chat attachments only — Project icons and other uploads are not
subject to it. Every upload, including deduplication, checks the current policy; existing
downloads remain available. Binary files are checked against their container signatures and text
against strict UTF-8, and a message part must name an attachment of the sender with the MIME type
it was stored as. No transcoding, frame extraction or local OCR is run.

## Delivery to the model

A model reads a binary file only if its metadata declares that input modality (`image`, `pdf`,
`audio`, `video`) **and** its protocol adapter can encode it: Responses and Anthropic carry images
and PDFs, Chat Completions adds MP3/WAV audio and video, Vertex-compatible carries all four. An
undeclared modality means the model cannot read the file — there is no optimistic attempt. Audio and
video travel inline; native Files references are used for images and PDFs where configured.
DashScope endpoints receive audio as a complete Data URL rather than bare Base64, as their
compatible API requires. Upstream filenames are `file.<ext>`: providers show them to the model, and
neither an attachment id nor the person's filename belongs there.

A file the current model cannot read is replaced by a sentence saying so. History follows the same
check when switching models, so a file the new model cannot read is not replayed. Text is readable
by every model and, without plugins, is inlined whole as `<file name="…">…</file>`; a file too large
for the model is the provider's error to report. A generated image's pixels are never replayed.

## Reading files (`file_reader`)

With `read_file` on, every file of the conversation is named by the first 8 hex digits of its
SHA-256 — attachment ids never appear in model-visible text:

    [image asset:3f9a2c1e "cat.png"]                          an uploaded image
    [file asset:b41d07a9 "report.pdf" application/pdf]        an uploaded PDF, audio or video
    <file asset="c07e11aa" name="page.html">…</file>          an uploaded text file up to 32 KiB
    [file asset:c07e11aa "big.html" text/html, 18432 lines — read it with read_file]
    [generated image asset:5c2e8f10]                          an image the chat model produced
    Generated 2 image(s): asset:5c2e8f10, asset:9a01d3c4      a generate_image task notification

Labels appear and disappear with the tool, so switching it mid-conversation re-renders the history
once. `asset:<prefix>` resolves only against the assets on the branch the model is answering — the
path from the root to the current message, plus files delivered earlier in the same turn. An asset
elsewhere is `FILE_NOT_FOUND`, never a hint that it exists; a prefix matching two assets is
`AMBIGUOUS_ASSET` and lists longer prefixes.

`read_file({ file, offset?, limit? })` reads text as numbered lines, a page at a time, and shows a
binary file whole: the tool result is a short receipt (`{ file, mime, message }`), and the file
follows in a user message wrapped in `<tool_attachment call_id="…" asset="…">` … `</tool_attachment>`.
Parallel calls finish all their receipts before the file messages are appended, and the history
rebuilds the same bytes. Tool results never contain attachment ids, base64 or bytes. A file the
model cannot read is an `UNSUPPORTED_FILE` error, which may say where else it can go.

The plugin provides the `fileReader` service. Other plugins inject it to resolve references, and
extend it: `registerScheme` adds a scheme (and optionally bare paths) whose plugin authorizes its own
references, and `registerHint` finishes the sentence telling the model a file cannot be read.

## Workspace files

The workspace-files plugin keeps model-written files under `/conversation` and `/project`. It
registers the `vfs:` scheme and bare paths with the file reader while the turn has workspace tools,
checking the mount's scope, and reads its text with the version `write_file` needs. Path arguments
accept a bare path or its `vfs:` form interchangeably.

Workspace files can be binary; anything that is not text is. `copy_file(from, to)` copies an asset
or another workspace file into the workspace — the new file points at the same stored bytes rather
than duplicating them — which is how an uploaded page gets edited and downloaded again. `write_file`
and `edit_file` refuse a binary file with `BINARY_FILE`. Assets are immutable: tools that would
change an `asset:` reference answer `READ_ONLY` and point to `copy_file`.

The file panel lists 当前会话, 本会话的附件 (the conversation's uploads and generated files across all
branches, read-only) and 当前项目, and — while the memory plugin is on — 记忆 · 你 and 记忆 · 当前项目.

### Memory mounts

`/memory/user` (the user's, shared by every conversation) and `/memory/project` (the conversation's
Project, a namespace separate from `/project`) hold the memory plugin's files. Every
`WorkspaceScope` says which of the two are reachable. In the hub only a turn the memory plugin
opened — one that offers `memory_save` — can reach them, through tools and `vfs:` references alike,
and only the layers that are on for its conversation: the user's switch, the Project's two switches
and the conversation's own, combined by `memoryScopes` (`src/plugins/memory/shared.ts`). The file
panel applies the same rule; the memory pages (the plugin's data page and the Project's 记忆 tab)
ignore it, so a layer switched off is hidden from the model but never from its owner. A closed
mount answers `MOUNT_UNAVAILABLE` and `/` does not list it.

`workspace_files.mount` records which mount a row belongs to. Nothing infers it from
`project_id` / `conversation_id`, which cannot tell `/project` from `/memory/project` or a user's
memory from an orphan: an orphan is a `conversation` file whose conversation is gone, so deleted
memory goes to the ordinary trash, can be restored, and is never swept with the orphans. Preview
tickets carry the mount too, and each mount has its own archive.

Nothing a person sees names a file by `asset:` or `vfs:`: those are how the model refers to files.
Tool results carry the file's name, and tool cards show it, a path's last segment, or what kind of
file it is.

## File understanding

`analyze_file({ file, question? })` hands a binary file to the file understanding model and returns
`{ file, mime, model, text, truncated }` — for a file the chat model cannot read, or for a careful
second reading. When it is on and its model can read a file, `read_file`'s cannot-read error points
at it.

Settings → 全局服务模型 selects the file understanding model and edits its system instruction. The
question travels separately from the instruction, after the file and a `File type: <MIME>` line;
without one, the model describes the file fully. The result records the model, its provider and the
tokens it used, shown on the tool card and never added to the reply's own usage.
The default instruction focuses on detailed visual descriptions and preserves transcribed text in
its original language. A prompt equal to its default is stored as unset, so a changed default takes
effect. The analysis is stored as an ordinary tool result: replaying history does not analyse again.

## Generated images

R2 is the only durable store for file bytes — uploads, generated images and binary workspace files
alike; everything else carries an `attachment_id`. A model's image output
is validated, hashed, written to R2 and reduced to an `attachment_id` *before* anything else sees
it, so D1 message JSON, the Durable Object's in-flight snapshot and every WebSocket frame carry the
id and nothing else — never base64, never raw bytes, never the provider's temporary URL. Identical
bytes dedupe by SHA-256. If any step fails, the reply ends as an error with its text intact and no
orphan row, no half-written R2 object and no file content anywhere.

## Known gaps

- **Upload purpose is declared by the client.** The upload route applies the chat upload policy to
  `purpose=chat` and fixed image rules to `purpose=image` (Project icons, Studio references). A
  client can upload an image as `image` and attach it to a chat message, getting past a closed or
  narrower chat policy for images up to 20 MiB. Checking the policy again at send time would close
  it, at the cost of refusing edits of old messages whose attachments a later policy disallows.
