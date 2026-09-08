# Codex OAuth Provider Design

## Goal

Add a first-class Codex provider that uses a ChatGPT subscription through Codex device-code OAuth. Users can create multiple independent Codex providers, each bound to one ChatGPT account. Only Chat owns the encrypted credentials and calls the fixed Codex upstream directly from Cloudflare Workers.

The provider is not a configurable compatibility endpoint. Its authentication, protocol, upstream URLs, headers, model discovery, and token lifecycle are fixed by the implementation.

## Scope

- Create multiple independent Codex providers; users select them explicitly like other providers.
- Authenticate with the Codex device-code flow without asking for an API key or token.
- Create the provider only after OAuth succeeds.
- Store and refresh OAuth credentials exclusively on the server.
- Discover and reconcile models from the fixed Codex model endpoint immediately after connection and on manual refresh.
- Support Responses streaming, text, inline image input, reasoning, and any function tools supplied by the host generation runtime.
- Reconnect, disconnect, revoke, delete, and terminal credential-failure states.
- Preserve provider/model configuration and history across reconnects.

## Non-goals

- Account pooling, quota-based routing, automatic failover, or round-robin selection.
- Custom Codex endpoints, protocols, headers, client IDs, or OAuth scopes.
- Codex hosted Files. User images are sent inline in the MVP.
- Image generation, image-only models, and multi-turn image editing.
- Realtime, voice, WebSocket Responses transport, and remote compaction.
- Cron-driven authorization or proactive token refresh.
- Claude Code OAuth.

## Provider Identity and Invariants

`providers.kind` distinguishes `custom` from `codex-oauth`. Existing rows migrate to `custom`.

A Codex provider:

- has no API key;
- owns exactly one `responses` interface;
- uses the fixed Codex base URL;
- has `native_files = false`;
- cannot add, remove, or edit interfaces;
- cannot change protocol, endpoint, authentication mode, client ID, or OAuth scope;
- may change only its display name and enabled state through the general provider editor;
- retains its models when disconnected or when credentials require reconnection.

Service-layer validation enforces these invariants for every write. The database stores the fixed interface so existing model-to-interface relations and effective-interface resolution remain unchanged.

Each successful new login creates a provider named `Codex · <account email>`. The name remains user-editable. A ChatGPT account may back only one Codex provider per Only Chat user. Reconnecting an existing provider must authenticate the same ChatGPT account; connecting another account requires a new provider.

## Data Model

Add `providers.kind`, with a non-null default of `custom` and a check constraint covering `custom` and `codex-oauth`.

Add a one-to-one `provider_oauth_credentials` table:

| Column | Meaning |
| --- | --- |
| `provider_id` | Primary key and cascading reference to `providers.id` |
| `status` | `connected`, `reconnect-required`, or `disconnected` |
| `encrypted_bundle` | AES-GCM ciphertext containing the OAuth token bundle; null while disconnected |
| `account_id` | Stable upstream account identity used for reconnect and duplicate checks |
| `account_email` | User-visible account label |
| `access_expires_at` | Access-token expiry used to decide whether refresh is required |
| `revision` | Monotonic compare-and-swap revision for token rotation |
| `last_error` | Sanitized terminal credential error; never contains a token or upstream body |
| `updated_at` | Last state change |

The encrypted bundle contains the access token, refresh token, ID token, token type, account ID, and expiry returned by the token endpoint. It is encrypted with the existing `KEY_ENCRYPTION_SECRET` machinery. Tokens and raw OAuth responses never enter DTOs, logs, error messages, model metadata, or Durable Object WebSocket events.

`providers.credential_version` identifies a logical credential connection. It increments on reconnect and disconnect so any credential-scoped remote references cannot survive a connection replacement. Normal access-token refresh increments only `provider_oauth_credentials.revision`; it does not change `credential_version`.

The provider DTO adds `kind`. A Codex provider also returns a non-secret OAuth summary containing status, account email, access-token expiry, and sanitized last error. `account_id` and the encrypted bundle remain server-only. Existing `has_key` behavior applies only to custom providers.

## OAuth Flow

### Pending state

OAuth coordination belongs to the user's `UserHub` Durable Object. REST handlers call public Durable Object RPC methods so login polling and generation-time refresh share one strongly consistent coordinator.

The Durable Object stores one encrypted pending record per flow ID:

- operation: new provider or reconnect;
- target provider ID for reconnect;
- OpenAI device authorization ID and user code;
- verification URL;
- upstream polling interval;
- creation, next-poll, and expiry timestamps.

Pending records expire after the upstream device-code lifetime. Closing the UI may cancel the local flow; abandoned records are removed lazily when read or after expiry. They never create provider rows.

### Start

`POST /api/codex/oauth/start` starts a new-provider flow. `POST /api/providers/:id/codex/reconnect` starts a reconnect flow after validating ownership and provider kind.

`DELETE /api/codex/oauth/:flowId` cancels a pending local flow and removes its Durable Object record. It does not revoke or modify any already-connected provider.

The Durable Object requests a device code from the fixed OpenAI endpoint with the fixed public Codex client ID. The response returns an opaque Only Chat flow ID, verification URL, user code, polling interval, and expiry. The browser opens the verification URL and shows the code and countdown.

### Poll and completion

`POST /api/codex/oauth/:flowId/poll` performs at most one upstream poll. Calls made before `next_poll_at` return `pending` without contacting OpenAI. A pending upstream response advances `next_poll_at`; denial, expiry, cancellation, and permanent errors terminate the flow.

On authorization, OpenAI returns an authorization code and PKCE verifier. The Durable Object exchanges them through the fixed Codex token endpoint and fixed device callback URI, validates the returned identity, and removes the pending record.

For a new connection, completion rejects an account already connected to another Codex provider. Otherwise one atomic D1 batch creates:

1. the `codex-oauth` provider;
2. its fixed Responses interface;
3. the connected OAuth credential row;
4. the provider's default-interface link.

For reconnect, completion requires the same stored account ID, replaces the encrypted bundle, sets the status to `connected`, clears the error, increments the OAuth revision, and increments `providers.credential_version` with a conditional write.

After the credential transaction commits, the server immediately runs provider-model reconciliation against the fixed Codex model endpoint. Models discovered during this first successful sync are enabled so the new provider is immediately usable; models discovered by later manual refreshes keep the existing disabled-by-default behavior. Model-sync failure does not roll back a valid OAuth connection. The API returns the connected provider plus a sanitized sync warning, and the user can retry from provider settings.

## Credential Lifecycle

### Just-in-time refresh

Before model discovery or generation, the credential manager loads the latest D1 row. It refreshes when the access token is expired or within five minutes of expiry.

Refreshes are single-flight per provider inside `UserHub`. Before sending a refresh request, the manager re-reads the credential row. A successful rotation is persisted only when the row still has the expected revision and encrypted bundle. If another operation changed the credentials, the manager discards its result and reloads the current row.

The refresh response may rotate any of the access, refresh, or ID tokens. Missing optional replacement fields retain their current values. The account identity must remain unchanged. A successful refresh increments only the OAuth revision.

Transient network, rate-limit, and server failures fail the current operation without changing provider status. Expired, revoked, reused, invalid-grant, account-mismatch, and other permanent credential failures conditionally set `reconnect-required`. A newer credential revision always wins over an older failure.

### Unauthorized retry

The Codex fetch wrapper may force one refresh and retry when the upstream returns HTTP 401 before a successful response stream begins. It never retries recursively and never replays a stream after output has been observed. A terminal refresh result updates the credential status and surfaces a reconnect instruction.

### Disconnect, revoke, and delete

Disconnect and deletion attempt the fixed OpenAI revoke endpoint with the current refresh token. Revoke is best effort: local credential removal proceeds even when the remote call fails.

Disconnect clears the encrypted bundle, sets status to `disconnected`, increments the OAuth revision and provider credential version, and retains provider and model rows. Delete performs the same revoke attempt before deleting the provider and its cascading data.

Reauthorization always requires user interaction. The existing daily cron continues to refresh the model catalog and clean provider files; it does not refresh or recreate OAuth authorization.

## Codex Transport

Register a provider-kind adapter ahead of the generic protocol adapter. `custom` providers continue through the existing protocol map. `codex-oauth` providers resolve credentials and use the dedicated Codex adapter even though their stored interface protocol remains `responses`.

The adapter uses the installed `@ai-sdk/open-responses` implementation with provider name `responses`. This preserves the existing Responses provider-options namespace, function-tool forwarding, and raw reasoning event accumulation. Image-generation support remains in the separate image-only backlog and does not influence this transport choice.

The adapter fixes the Codex backend URL and applies a narrow fetch wrapper that:

- injects the current bearer access token and ChatGPT account header;
- applies the Codex originator and client headers used by the official client;
- forces stateless Responses operation and encrypted reasoning inclusion;
- supplies an empty `instructions` value when none exists;
- removes fields unsupported by the Codex backend rather than forwarding API-only state;
- keeps the existing per-generation observability wrapper while redacting credentials;
- performs the one allowed pre-stream 401 refresh retry.

Only Chat remains the conversation authority. It sends the complete selected message path on each request and stores/replays reasoning metadata as it does for other Responses providers. It does not use `previous_response_id`, OpenAI conversation storage, or remote compaction.

The dedicated model-list client uses the same credential manager and fixed Codex headers. It feeds the existing model reconciliation service, so enabled state, manual pinning, catalog metadata, and provider-removal semantics do not fork for Codex.

User images use the existing inline attachment path. Codex exposes no Files capability in this MVP.

## API and UI

The provider creation dialog adds a dedicated Codex entry separate from catalog and custom providers. Selecting it opens a device-login dialog with:

- the verification URL action;
- the one-time user code and copy action;
- an expiry countdown;
- pending, success, denied, expired, cancelled, and failed states;
- cancellation that never leaves a half-created provider.

Successful creation navigates to the new provider settings page. Multiple Codex providers appear independently in provider navigation and model selection.

Codex provider settings show:

- editable display name and enabled state;
- connected account email;
- connected, reconnect-required, or disconnected status;
- access-token expiry as diagnostic state, not as a credential field;
- model-sync status and the existing model list;
- reconnect, disconnect, refresh-models, and delete actions.

The page does not render API key, endpoint, interface, protocol, or native-Files controls. The compact provider editor follows the same restriction.

Generation against a disconnected or reconnect-required provider fails before creating an upstream request and instructs the user to reconnect that provider.

## Errors, Security, and Observability

- OAuth and model operations classify pending, transient, permanent-credential, usage-limit, and ordinary upstream failures separately.
- Upstream bodies are parsed for known codes but are never stored or returned verbatim when they may contain credentials or account data.
- Logs contain provider ID, operation, status code, retry category, credential revision, and request trace IDs; they exclude tokens, authorization codes, device authorization IDs, user codes, account IDs, and raw authorization headers.
- OAuth DTOs are strict schemas. General provider writes reject Codex-only or credential fields rather than ignoring them.
- OAuth completion, reconnect, refresh, disconnect, and delete use conditional writes so stale operations cannot replace newer credentials.
- Cloudflare Access remains the outer authentication boundary for the application. OAuth endpoints add no public callback exception.

## Testing

All automated tests use mocked OpenAI endpoints and synthetic credentials.

Unit coverage includes:

- device-code and token-response parsing;
- pending-flow expiry and poll throttling;
- credential encryption/decryption without log exposure;
- refresh response merging and permanent/transient classification;
- Codex request headers and body normalization;
- fixed provider write invariants;
- provider-kind dispatch ahead of generic protocol dispatch.

Worker integration coverage includes:

- start, pending poll, completion, cancellation, denial, and timeout;
- no provider row before successful authorization;
- atomic provider/interface/credential creation;
- duplicate-account rejection;
- reconnect account matching and credential-version increment;
- concurrent refresh compare-and-swap and stale-failure suppression;
- one pre-stream 401 refresh retry;
- disconnect and delete despite revoke failure;
- initial model-sync success and retained provider on sync failure;
- fixed endpoint enforcement in direct API calls;
- Responses text streaming, reasoning replay, synthetic function-tool forwarding, and inline image input;
- disconnected and reconnect-required generation errors;
- existing custom providers remaining unchanged after migration.

After deployment, manual acceptance uses a real ChatGPT account to verify device authorization, model discovery, one text stream, reasoning replay, one function tool call, one inline-image request, reconnect, and disconnect. No real token is captured by tests or logs.

## Image-only Generation Backlog

Image generation is a separate architectural feature and is not part of this implementation.

The follow-up design must provide:

- a generic image-only execution contract independent of Codex;
- protocol drivers for OpenAI Images, OpenRouter Images, and later image APIs;
- explicit protocol routing rather than inferring an endpoint solely from output modalities;
- an input UI matching chat composition while treating every generation as an independent request;
- clear visual separators explaining that text history is not inherited;
- explicit reference to the previous generated image to enter edit mode;
- persisted attachment references so regeneration is deterministic;
- global default, operator/provider default, and current-session override resolution for the image-generation model;
- both direct image-only models such as `gpt-image-2` and conversational models using an image-generation tool;
- reuse of the existing R2 validation, hashing, deduplication, and message image persistence pipeline.

## Acceptance Criteria

- A user can connect more than one distinct ChatGPT account as independent Codex providers without entering a key, token, endpoint, or protocol.
- Cancelling or failing login leaves no provider.
- A connected provider discovers models and completes ordinary Responses generations from a Cloudflare Worker.
- Text, reasoning, host-supplied tools, and inline image input survive through the existing message model.
- Tokens refresh without stale writes; permanent credential failure requires explicit reconnection.
- Reconnect preserves provider identity, models, projects, sessions, and message history.
- Codex configuration cannot be changed into a custom endpoint through either UI or direct API input.
- Existing custom providers and their credential behavior are unchanged.
- No Files, image-generation, Realtime, voice, or compaction behavior is introduced.
