# Providers

How providers, interfaces and models are configured, and how native Files uploads are scoped and cleaned up.


## Interfaces and Vertex-compatible gateways

A provider owns its name, shared API key and enabled state. Each configured format owns its Base URL
and Files setting. Models follow the provider default unless they explicitly select another owned
interface. API addresses and keys cannot be overridden on an individual model.

`vertex-compatible` takes an ordinary Base URL and
a plain API key sent as `Authorization: Bearer <key>`; Google's own `x-goog-api-key` header is
stripped. Requests are addressed as `{base_url}/v1/publishers/{publisher}/models/{model}`, so model
ids are entered as **`{publisher}/{model}`** (for example `google/gemini-3-pro-preview`). Only the
first slash separates the two halves, so a model name containing slashes survives intact.

Remote model import is disabled when the default interface is Vertex-compatible. Native Google
Vertex service-account authentication, Project and Location configuration are unsupported.

## Model metadata

models.dev supplies fallback names, capabilities, reasoning options, limits and prices. Per-model
metadata overrides take precedence, including explicit false, zero and nullable values. Catalog
refreshes never add models: remote `/models` results and manual entries determine membership.

`reasoning_options` controls available effort levels and whether explicit reasoning disablement is
supported. `modalities` describes input (`image`, `pdf`, `audio`, `video`) and image output — an
input it does not declare is one the model is never sent; `tool_call` describes tool support.
Reasoning settings affect the current request only. Returned reasoning and its provider metadata
are stored and replayed regardless of the toggle or capability metadata.

Whenever reasoning is on, every protocol asks for readable reasoning: Responses sends
`reasoning.summary: 'auto'`, Anthropic sends `thinking: { type: 'adaptive', display: 'summarized' }`
and Vertex sends `includeThoughts`. Recent Claude models default to empty thinking blocks, and a
gateway that translates Responses into Anthropic Messages (CLIProxyAPI) maps `reasoning.summary` onto
`thinking.display`, so dropping the summary request leaves every Claude turn with blank thinking. A
provider that returns full reasoning text (DeepSeek) still has it shown in preference to a summary.

Reasoning strength itself is three-state everywhere: absent means *inherit* from the Project,
`null` means *explicit Auto* (reasoning on, no effort sent), and a string is an explicit strength.

## `native_files`: scoped uploads and remote cleanup

Files is configured per interface and defaults off. Enable it for endpoints that implement the
corresponding Files API. Responses and Chat Completions use OpenAI Files; Anthropic uses Anthropic
Files. Vertex-compatible interfaces have no Files API. Without native Files, attachment transport
uses supported URLs or inline bytes.

With it on:

- Upload reuse is scoped to the attachment, provider, credential version, Files family and normalized
  Base URL. Responses and Chat Completions share pointers when they use the same file endpoint.
  Each upload creates a new row; expired historical references remain available for remote cleanup.
- Uploads ask for a **seven-day** expiry. If the provider reports its own `expires_at`, that value is
  what gets stored; otherwise the local pointer dies on the deadline the upload asked for.
- Upload HTTP 400/404/405/501 means the compatible endpoint cannot honor the Files contract, so that
  request falls back to inline bytes without saving a pointer. Authentication, throttling, network
  and other server failures still fail the turn instead of being disguised as missing capability.
- The daily cron (`0 3 * * *`) independently refreshes the catalog and deletes expired remote files.
  Cleanup reads indexed due pointers in pages, with bounded concurrency and a per-run limit.
  Success and HTTP 404/410 remove the pointer. Network errors, SDK-retryable errors (including HTTP
  408/409), HTTP 401/403/429 and server errors defer it by a day; unrecoverable references are logged
  without sensitive data and removed locally.
- Provider deletion, interface removal, key replacement and endpoint changes attempt affected
  remote deletes before changing the configuration. The operation proceeds despite remote failure;
  invalidated pointers are removed and old credentials are never retained for retries.
- Expired pointers never participate in generation. Cleanup never deletes R2 originals.
