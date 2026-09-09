# Image Generation and Artifact Foundation

## Scope

Only Chat will add a dedicated image-generation workspace and an image Gallery. The first implementation supports OpenAI-compatible Images APIs through existing `responses` and `chat-completions` provider interfaces. It establishes a general Artifact foundation so later audio, Markdown, HTML, video, and Agent-created files can reuse ownership, provenance, storage, and history.

Phase 1 includes:

- Image Studio and image Conversations.
- Image Gallery and route-backed image details.
- OpenAI-compatible `/images/generations` and `/images/edits` calls.
- Durable image jobs using Cloudflare Workflows.
- Generated-file provenance and Conversation/Message links.
- Global, provider, and Conversation image-model configuration.
- Provider `/models` image-capability normalization.
- Excluding known image-only models from the chat model picker.

Phase 2 is limited to stable interface boundaries in this design. It will later add the opt-in `generate_image` chat tool and Responses-native image generation.

Google and Vertex image output through chat remains unchanged. Phase 1 does not add a separate direct-image adapter for those protocols.

## Product Surfaces

### Routes

```text
/images                    Image Gallery
/images/new                New Image Studio
/images/s/:conversationId  Existing Image Studio
/images/a/:artifactId      Route-backed Artifact detail
```

The Artifact detail appears as a large modal on desktop and a full-screen view on mobile. Direct navigation to its route remains possible.

Short, non-sensitive `/new` query parameters are a future cross-product draft-bootstrap feature and are not part of Phase 1. Gallery actions use a source Artifact ID and load the immutable request snapshot from the server.

### Studio

Studio uses a canvas-first layout:

- Left: image Conversation history with latest output, title, and job status.
- Center: the current output; multiple outputs use a selectable grid and large preview.
- Right: model and generation parameters; mobile renders this area in a Drawer.
- Bottom: fixed prompt composer, reference-image list, and Generate action.

Submitting the first job creates an image Conversation and navigates from `/images/new` to `/images/s/:conversationId`. Leaving or refreshing the page does not stop the job. Returning restores status and results from durable state.

Completed output actions are Download, Use as reference, Generate again with the same request, Open details, and Delete.

### Gallery

Gallery flattens image Artifacts across all Conversations and sources into a cursor-paginated masonry view. It does not group by Conversation. Stored dimensions reserve layout space before the image loads.

Image details show:

- Original prompt and explicit parameters.
- Provider, interface protocol, model ID, and display-name snapshots.
- Dimensions, MIME type, creation time, and batch position.
- Source Conversation and Message when they still exist.
- Download, Copy prompt, Generate again, Use as reference, and Delete actions.

Generate again opens a new Studio draft populated from the source run. Use as reference creates a new draft with the selected Artifact as a reference image. Submitting either draft creates a new image Conversation; it does not mutate the source history.

## Conversation Semantics

`conversations` gains a `kind` discriminator:

```text
chat | image
```

Image Conversations reuse the existing Message tree and archive/delete behavior. A user Message stores the prompt and reference attachments; the assistant Message owns the run and output parts. Images APIs remain stateless: continuing an image Conversation sends only the current prompt, explicitly selected references, and current parameters. Previous turns are product history, not implicit provider context.

Generated image parts retain `attachment_id` for the existing authenticated file route and add an optional `artifact_id`. New generated output writes both IDs; legacy images without an Artifact remain valid. Reference-image Messages continue to carry Attachment parts, while `artifact_links(purpose=reference)` records the logical source when the reference came from Gallery.

`conversations` also gains nullable `image_provider_id` and `image_model_id` fields. These fields select an image model for both image Conversations and chat-Conversation overrides. Existing `provider_id` and `model_id` retain their chat-model meaning.

Conversation lists and indexes include `kind` so chat navigation does not scan or display image Conversations and Studio history does not display chat Conversations.

## Artifact Data Model

### Artifact runs

`artifact_runs` represents one durable operation:

```text
id
user_id
client_request_id      unique per user
kind                  image_generation
source                studio | tool | provider_tool | chat_output
operation             generate | edit
status                queued | running | completed | failed | cancelled
conversation_id       nullable, ON DELETE SET NULL
message_id            nullable, ON DELETE SET NULL
tool_call_id          nullable
provider_id           nullable
provider_name         snapshot
interface_id          nullable
interface_protocol    snapshot
credential_version    snapshot
model_id              snapshot
model_name            snapshot
prompt
params                 JSON
workflow_instance_id  unique
error                  nullable, sanitized
created_at
started_at             nullable
completed_at           nullable
```

`params` stores the canonical request snapshot, not provider request JSON:

```ts
interface ImageGenerationParams {
  count: number
  size: null | { width: number; height: number }
  quality?: string
  background?: 'transparent' | 'opaque'
  output_format?: 'png' | 'webp' | 'jpeg'
}
```

`size: null` means the size was omitted and the provider selected its default. Custom-size mode initially fills `1024 × 1024` but accepts positive integer width and height. Phase 1 does not impose provider-specific minimums such as Seedream's larger sizes; provider errors remain visible. Model-specific presets may be added later without changing the persisted shape.

### Run inputs

`artifact_run_inputs` is an ordered relation table:

```text
run_id
attachment_id
position
```

It does not duplicate `user_id`. Creating the relation transactionally proves that the run and attachment share an owner.

### Artifacts

`artifacts` represents a logical generated output:

```text
id
user_id
run_id
kind             image
attachment_id
output_index
width
height
mime
created_at
deleted_at       nullable
```

One run may produce multiple Artifacts. `(run_id, output_index)` is unique, which makes Workflow publication idempotent. Gallery uses an index beginning with `(user_id, kind, deleted_at, created_at, id)`.

### Artifact links

`artifact_links` records current usage:

```text
artifact_id
conversation_id
message_id
tool_call_id     nullable
purpose          output | reference
```

The relation does not store `user_id`. Link creation validates that the Artifact, Conversation, Message, and referenced Attachment belong to the same user. Indexed `conversation_id` and `message_id` support deletion without scanning Message JSON.

### Attachments

`attachments` remains the physical-file record and continues to own R2 location, content hash, MIME type, dimensions, size, origin, and `user_id`. Hash deduplication remains scoped to one user. An Attachment may be referenced by messages, Artifacts, Project icons, run inputs, or provider-file pointers.

Normal user uploads do not automatically become Artifacts. Model/Agent outputs become Artifacts automatically. A future explicit Save to library action may promote an upload.

## Ownership and Authentication

The implementation uses the merged Better Auth system and does not use `DEFAULT_USER_ID`.

- REST endpoints run behind `requireAuth` and obtain identity using `authUserId(c)`.
- The client never submits `user_id`.
- UserHub instances use the authenticated `hub.userId` already assigned to their Durable Object.
- Workflow arguments contain only `{ userId, runId }` as identity and job location.
- Every Workflow step reloads the run using both ID and owner.
- Provider, Model, Interface, Conversation, Message, Attachment, Run, and Artifact operations are owner-fenced.
- Workflow status broadcasts target `USER_HUB.getByName(String(userId))`.
- No request, run, log, or Artifact stores provider credentials.

Ownership remains user-based for Phase 1. Public sharing, teams, workspaces, and cross-user access are out of scope.

## Model Discovery and Selection

Provider `/models` responses are not assumed to share an extension schema. For example, Volcengine nests modalities and exposes `domain` and `task_type`, while ZenMux exposes top-level modalities, `display_name`, `owned_by`, `capabilities`, and `pricings`.

Model synchronization stores a bounded raw `provider_metadata` JSON snapshot and maps recognized fields into the existing normalized metadata. Raw metadata is not selected by normal model-list queries or rendered directly. Oversized or non-JSON provider values are discarded before persistence. Normalization recognizes at least:

- `modalities.input_modalities` and top-level `input_modalities`.
- `modalities.output_modalities` and top-level `output_modalities`.
- `task_type` values such as `TextToImage` and `ImageToImage`.
- `domain: ImageGeneration`.
- Human-readable names and known capability fields.

Provider-returned values outrank models.dev fallback values. User model overrides remain authoritative. `/models` metadata is not expected to contain size, quality, count, or format constraints.

Chat model selection excludes a model only when resolved metadata explicitly says its output includes image and excludes text. Unknown legacy output metadata remains visible. Studio lists only enabled models whose selected Interface has an Images adapter and whose resolved output includes image.

An edit request requires resolved image input support. The client disables references for incompatible models, and the server repeats the check before creating a run.

## Image Model Configuration

Defaults resolve as:

```text
Conversation image-model override
  > current chat Provider's default image model
  > User global default image model
```

Storage:

- `users.settings.image_model`: nullable `{ provider_id, model_id }`.
- `providers.default_image_model_id`: nullable model ID owned by that Provider.
- `conversations.image_provider_id` and `image_model_id`: nullable complete override.

Provider settings may select only that Provider's own enabled Studio-compatible image models. Global and Conversation settings may select any owned, enabled Studio-compatible image model. Studio new drafts begin with the global default and allow a direct selection; the selected model is persisted on the image Conversation.

Configuring a model does not automatically inject a chat tool. Phase 2's `generate_image` remains an explicit, stable Conversation tool selection so existing prompt prefixes and model behavior do not change.

## Studio Parameters

Phase 1 exposes:

- Prompt, required.
- Reference images, optional.
- Count, default `1`.
- Size: Auto by default; custom width and height initially `1024 × 1024`.
- Quality: Auto, known suggestions `low`, `medium`, `high`, and a custom value.
- Background: Auto, `transparent`, or `opaque`.
- Output format: Auto, `png`, `webp`, or `jpeg`.

Auto means omission. Except for count, an unset field is not sent to the provider. Phase 1 does not expose masks, seed, style, watermark, partial-image streaming, or raw provider JSON.

The UI does not ask whether the operation is generation or editing. No references means `generate`; one or more references means `edit`. Adapters map the canonical operation to provider endpoints.

## Protocol Adapter

The existing `LlmProtocolAdapter` gains an optional Images capability alongside `createModel` and `createFiles`:

```ts
interface LlmProtocolAdapter {
  createModel(...): LanguageModel
  createFiles?(...): ScopedFilesClient
  createImages?(...): ScopedImagesClient
}
```

`responses` and `chat-completions` register the same OpenAI-compatible Images client. It reuses the selected Interface base URL and Provider API key. Model-level Interface overrides therefore work without new endpoint or credential fields.

The client maps:

- `generate` to `POST {baseURL}/images/generations` with JSON.
- `edit` to `POST {baseURL}/images/edits` with multipart reference images.

Only explicitly set optional parameters are sent. Output parsing accepts base64 payloads and temporary URLs. Temporary URLs are downloaded immediately. The adapter returns controlled file streams/bytes and provider response metadata; it never persists base64 in Message or run JSON.

Google/Vertex protocols do not implement `createImages` in Phase 1.

## Durable Execution

Image generation uses a dedicated Cloudflare Workflow. The request path performs a durable handoff before returning:

1. Authenticate and validate ownership and capabilities.
2. Determine `generate` or `edit` from references.
3. Create the image Conversation and Message shell when needed.
4. Insert `artifact_run(status=queued)` and ordered inputs.
5. Start a Workflow using a stable instance ID derived from the run.
6. Return `202 Accepted` with Conversation, Message, and run IDs.

The Workflow:

1. Loads `(runId, userId)` and checks terminal status.
2. Revalidates owner-fenced Provider, Model, Interface, inputs, and the captured credential version.
3. Marks the run `running` and notifies the user's UserHub.
4. Executes one provider generation call.
5. Validates MIME, byte size, and non-empty outputs.
6. Writes originals to R2 and idempotently creates Attachments, Artifacts, and links.
7. Publishes all outputs before atomically marking the run `completed`.
8. Marks failures with a sanitized error and notifies UserHub.

The provider-generation step does not retry automatically. Compatible gateways may ignore `Idempotency-Key`; retrying an ambiguous completed request can duplicate cost. The adapter still sends a stable run-based idempotency key. R2 and D1 publication steps remain idempotent and retryable.

Cancellation is best effort. A queued run may be cancelled before the provider call. A running fetch receives an abort request where possible; if the remote call has already completed, cancelled output is not published. Terminal status transitions are compare-and-set operations.

WebSocket events improve immediacy but are not authoritative. Studio and Gallery can reload run state through REST after reconnect or refresh.

## API and Events

Phase 1 exposes authenticated endpoints equivalent to:

```text
POST   /api/artifact-runs/image
GET    /api/artifact-runs/:id
POST   /api/artifact-runs/:id/cancel
GET    /api/artifacts?kind=image&cursor=...
GET    /api/artifacts/:id
DELETE /api/artifacts/:id
GET    /api/artifacts/:id/content
```

The create endpoint accepts `client_request_id` for idempotent submission. All returned IDs belong to the authenticated user. Errors distinguish validation, unavailable model/interface, provider rejection, cancellation, and internal persistence failure without returning credentials or raw provider bodies.

UserHub broadcasts compact run-created, run-updated, Artifact-created, and Artifact-deleted events. The client reconciles events with authoritative REST snapshots.

## Image Delivery

Original files remain in private R2. The authenticated Artifact content route checks ownership before reading the Attachment.

Production configures a Workers Images binding to transform the private R2 stream. It does not use anonymous `/cdn-cgi/image` URLs because URL transformations strip origin Cookie and Authorization headers and use a public cache. Supported variants are bounded:

```text
gallery  longest edge 512px, no enlargement, automatic efficient format
preview  longest edge 1536px, no enlargement, automatic efficient format
original no transform
```

When the Images binding is unavailable in local development, tests, or deployment, gallery and preview variants return the original after the same ownership check. Failure to transform also falls back to the original. Phase 1 does not persist thumbnail copies or maintain a thumbnail table.

## Deletion and Retention

Deleting a Conversation preserves generated Artifacts by default. Source Conversation and Message foreign keys become null, and Gallery displays that the source was deleted.

The delete dialog offers an unchecked `同时删除此对话中的附件和生成产物` option and previews affected counts. When selected:

- Remove the Conversation's Artifact links.
- Soft-delete Artifacts originating only from that Conversation and not linked elsewhere.
- Detach normal uploaded attachments from deleted messages.
- Delete an R2 object only after checking all Attachment, Artifact, Message, Project-icon, run-input, and provider-file references.

Deleting an Artifact removes it from Gallery but does not break other active references. Shared underlying Attachments remain until unreferenced. Expired provider-file pointers remain governed by the existing cleanup job.

## Phase 2 Boundary

Phase 2 adds an opt-in `generate_image` plugin tool. Its stable contract uses the same canonical image request, image-model resolution, Artifact run, Workflow, and Gallery publication.

The tool is selected per Conversation and remains stable for prefix caching. Global plugin settings may make it a default only for newly created Conversations. Configuring a default image model alone does not inject the tool.

When the Agent calls it, Only Chat persists the tool call, starts a durable run, and stops the current model generation. Workflow completion appends a compact Artifact tool result and later resumes the Agent through a compare-and-set continuation. Cancellation stops and waits for a new user message.

Responses-native image generation is used only when the current Responses adapter explicitly supports it and the resolved image model belongs to the same Provider. Its output is normalized into the same Artifact model. Detailed Agent-loop limits and provider-native behavior are deferred to the Phase 2 design.

## Observability

Structured events include user-safe identifiers and timings:

- Run queued, started, completed, failed, and cancelled.
- Provider/interface/model IDs and protocol, never credentials or prompts.
- Provider-call duration, download duration, persistence duration, output count, and byte sizes.
- Error category and sanitized provider status/code.
- Workflow retry and idempotent-publication outcomes.

Prompts, input images, output bytes, provider response bodies, authorization headers, and decrypted keys are never logged.

## Verification

Tests cover product-owned contracts:

- OpenAI-compatible generation JSON and edit multipart requests.
- Omitted Auto fields, arbitrary custom dimensions, and multiple references.
- URL and base64 provider outputs, MIME/size rejection, and R2 persistence.
- Workflow reload recovery, cancellation, terminal transitions, and idempotent output publication.
- Cross-user denial for Provider, Model, Interface, Conversation, Message, Attachment, run, and Artifact resources.
- Image Conversation filtering and restoration.
- Chat-picker exclusion only for explicitly known image-only models.
- Studio model availability, parameter serialization, multi-output display, and refresh recovery.
- Gallery cursor pagination, detail provenance, deleted-source state, and draft actions.
- Conversation deletion with and without generated-output cleanup.
- Authenticated original and transformed-image delivery, including no-binding fallback.

Before deployment, a manual smoke test uses configured low-cost provider credentials without logging secrets. Database migrations are applied remotely before code that depends on the new schema is deployed.

## Out of Scope

- Partial-image streaming and intermediate previews.
- Mask/inpainting UI.
- Direct Google/Vertex image-generation adapters.
- Audio, video, Markdown, or HTML library views.
- Public sharing, teams, workspaces, and cross-user access.
- Provider-specific seed, style, watermark, or arbitrary JSON controls.
- Automatic retries of ambiguous provider generation requests.
- Phase 2 Agent-loop implementation.
