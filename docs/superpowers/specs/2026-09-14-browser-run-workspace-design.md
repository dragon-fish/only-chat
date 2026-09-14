# Browser Run and the Workspace Panel

## Scope

Projects are becoming Agent Workspaces: a Project gains an execution environment and a browser the
model can drive, and the chat view gains a panel where the human watches and intervenes. The work is
split into three sub-projects, each with its own spec:

1. **Browser** (this document): a `browser_use` tool backed by Cloudflare Browser Run, executed as
   model-written Playwright code in a Dynamic Worker; Live View embedded in the app; human handoff.
   Alongside it, the core gains the Workspace Panel, per-conversation plugin settings, a plugin
   event channel, and a generic "human answers a tool" path.
2. **Sandbox**: Cloudflare Sandbox SDK containers per Project, command execution, an R2 archive
   mount, a terminal tab, hydrate/publish against Workspace Files.
3. **Workspace shell**: whatever the Project page still needs once both panels exist.

Out of scope here: Code Mode (a single tool that runs code calling other tools), Sandbox, session
recordings, Stagehand, MCP tools, browser access for conversations outside a Project.

## Platform facts this design relies on

- Cloudflare **Browser Run** (renamed from Browser Rendering in July 2026) is bound as
  `browser: { binding: "BROWSER" }`. `@cloudflare/playwright` 1.3.0 (Playwright 1.58.2) provides
  `launch`, `connect`, `sessions`, `history`, `limits`. A session closes after 60 s idle by default,
  extendable to 10 min with `keep_alive`; there is no maximum lifetime, but platform releases close
  sessions. Workers Paid includes 10 browser hours and 10 concurrent browsers per month, then
  $0.09/hour and $2/browser (monthly average of daily peaks).
- `Cloudflare.getLiveView` (a CDP command) returns a `devtoolsFrontendUrl` on `live.browser.run`,
  valid 5 min by default and up to 1 hour. The page is served with `frame-ancestors *`, so it can
  be embedded in an iframe. Mode `tab` is the interactive single-page view.
- **Dynamic Workers** (`worker_loaders: [{ binding: "LOADER" }]`) run untrusted code in an isolate.
  `env` may carry structured-cloneable values and service bindings, including loopback
  `WorkerEntrypoint` stubs created through `ctx.exports` with per-stub `props`. `globalOutbound: null`
  blocks `fetch` and `connect`. `get(id, cb)` caches by id; `load()` never caches. Workers Paid
  includes 1,000 unique Dynamic Workers per month, then $0.002 per Worker per day. A Durable Object
  may have 10 distinct Dynamic Workers in flight. `@cloudflare/vite-plugin` supports the binding in
  local dev.
- Playwright objects (`Page`, `Browser`) are not RPC-serialisable. Everything that touches them runs
  inside the Dynamic Worker; the host only sees strings, bytes and JSON.

## Plugin

Built-in plugin `cloudflare_browser_run`, directory `src/plugins/cloudflare-browser-run/`, the usual
`manifest.ts` / `shared.ts` / `server/` / `client/` layout. The manifest declares
`requiresProject: true`; `ToolRegistry.usable` and the client tool selector exclude such a plugin's
tools when the conversation has no Project.

Two tools, one group:

| Tool | Role |
| --- | --- |
| `browser_use` | Runs a model-written ES module against the conversation's browser. |
| `browser_handoff` | No `execute`. Asks the human to take over the live browser and waits. |

### The `browser_use` contract

The tool description carries this declaration verbatim; it is the model's whole API.

```ts
// Export `run`. `page` is already connected to this conversation's browser and keeps its tabs,
// cookies and login state between calls. Return a string or a JSON-serialisable object.
export async function run(ctx: {
  page: Page               // Playwright Page: goto, locator, fill, click, ariaSnapshot, screenshot …
  browser: Browser         // for a new tab or a new context
  log(...args: unknown[]): void             // shown to the user live and returned to you
  screenshot(name?: string): Promise<void>  // saved as an attachment and shown to you if you can see images
}): Promise<string | object>
```

Input: `{ code: string, timeout_ms?: number }`. Code is at most 32 KiB; `timeout_ms` defaults to
the plugin's `default_timeout_ms` and is capped at 300,000.

Result:

```json
{
  "result": "…",
  "logs": "…",
  "logs_truncated": false,
  "screenshots": [{ "attachment_id": 1, "name": "before-submit" }],
  "url": "https://…",
  "title": "…"
}
```

The description follows the house style: what it does, when to reach for it, limits, what it
returns. It says that `goto` plus `ariaSnapshot()` is how to read a page, that `page.evaluate` is
available, that there is no network access from the code itself, that a second browser cannot be
launched, and that `browser_handoff` is the way past logins, MFA and CAPTCHAs.

There is deliberately no `browser_read`, `browser_evaluate` or per-action tool set. The boundary is
the gateway and `globalOutbound`, not a trimmed API.

### `browser_handoff`

Input `{ instructions: string }`. The generation stops after this call, exactly as it does for
`ask_user`. The human answers through the panel or the tool card with
`{ status: "done" | "failed", note?: string }`, the client sends `tool.respond`, and the generation
continues. On `done` the host exports the browser's storage state (see below).

## Execution

A Durable Object has no `ctx.exports`, so the Dynamic Worker is loaded by `BrowserRunner`, a
`WorkerEntrypoint` exported from the Worker and reached from the hub through a self service binding
(`BROWSER_RUNNER`). The runner is stateless; the hub keeps every fact that outlives a call.

One `browser_use` call:

1. The hub validates code size and timeout, acquires or verifies the conversation's session, and
   calls `env.BROWSER_RUNNER.run({ userId, conversationId, messageId, callId, code, sessionId,
   storageState, timeoutMs, liveViewTtlMs })` under the conversation's lock.
2. The runner calls `env.LOADER.load(…)` — never `get`: the stubs in `env` carry this run's session
   and generation, and a cached isolate would keep the previous run's — with:
   - `mainModule: "main.js"` (a constant class extending `WorkerEntrypoint`), `runtime.js` (the
     prebuilt harness + Playwright bundle read from `env.ASSETS`), `user.js` (the model's code, or a
     stub for a probe).
   - `env: { BROWSER: gatewayStub, HOST: hostStub }`, loopback stubs from the runner's `ctx.exports`
     with `props` naming the session and the generation.
   - `globalOutbound: null`, `compatibilityDate` matching the Worker, `compatibilityFlags:
     ["nodejs_compat"]`, `limits: { cpuMs }`.
3. Inside the Dynamic Worker the harness connects through `env.BROWSER`, reuses the context that has
   pages or creates one with `storageState`, takes the last page or opens one, sends
   `Cloudflare.getLiveView` once, then races the model's `run` against `timeoutMs`. Afterwards it
   exports `context.storageState({ indexedDB: true })`, disconnects (never closes unless asked) and
   returns `{ ok, result | error, timedOut, url, title, storageState, liveView, screenshots }`.
4. Logs and screenshots arrive through `HOST.log` / `HOST.attach` while the code runs. `BrowserHost`
   forwards each into the user's Durable Object (`UserHub.pluginHostCall`), which stores screenshots
   as attachments, appends lines to the call's scratch, and broadcasts `tool.progress`.
5. The hub assembles the tool result from the runner's answer and the scratch.
6. Screenshots reach the model through the tool's `toModelOutput`, as media beside the JSON, only
   when the model declares image input. The persisted result carries attachment ids, never bytes,
   so later turns resend nothing. This is a deliberate departure from attaching image parts to the
   assistant message: the generation loop has no hook for a tool to contribute message parts, and
   building one is a core change of its own.

### Gateway stub

`BrowserGateway extends WorkerEntrypoint` implements only `fetch`. It forwards a WebSocket upgrade
to `env.BROWSER` when the request is a `connect` to the session named in `ctx.props.sessionId`,
and answers 403 to everything else. Sessions are acquired only by the hub, through the binding's
control endpoints. Model code that imports Playwright and tries to open its own browser gets 403.

### Host stub

`BrowserHost extends WorkerEntrypoint` with `log(line)` and `attach(name, mime, bytes)`. The Live
View link travels back in the run result. `ctx.props` carries user, conversation, message and call
ids, so a stub can only write into the generation it was created for. Attachments are capped at 8
per run; logs at 16 KiB of what is returned to the model (the UI stream is uncapped).

### Playwright bundle

`scripts/build-browser-runtime.ts` (esbuild, run by `pnpm build`) bundles the harness and
`@cloudflare/playwright` into one ES module with `cloudflare:*` left external, written into the
static asset output. Its content hash is part of the loader id, so a rebuilt bundle never reuses a
cached isolate.

## Sessions and login state

- **Live session per conversation.** UserHub storage holds `browser:<conversationId>` →
  `{ sessionId, startedAt, keepAliveMs }`. Before each run the host `connect`s; on failure it
  `launch`es with `keep_alive` and stores the new session. After each run it disconnects. The session
  is closed when the conversation is deleted or the user presses 关闭浏览器 in the panel.
- **One connection at a time per conversation.** Browser Run allows one connected client per
  session, so the host serialises every connection through a per-conversation lock: runs, Live View
  refreshes and storage-state exports never overlap.
- **Login state per profile.** Conversation setting `browser_profile` ∈
  `ephemeral | project | user`, default `project`. Storage state is a Playwright `storageState`
  JSON in KV under `browser-profile:project:<projectId>` or `browser-profile:user:<userId>`;
  `ephemeral` stores nothing. It is written after every run and after a completed handoff, and read
  when a new browser is launched.

## Live View and events

- New plugin-scoped broadcast: the server plugin calls `hub.broadcastPlugin(pluginId, payload)`;
  clients receive it through `ctx.events.on(handler)` and only for their own plugin. This is the
  channel for `browser.session`:
  `{ conversation_id, status: "active" | "closed", live_view_url, live_view_expires_at, profile,
  started_at }`. The core does not know any specific payload.
- Live View URLs are requested with `expiresInMs: 3600000`. During a run the harness fetches one;
  when idle, the hub runs a probe (the same Dynamic Worker without model code) that connects,
  fetches, exports the storage state and disconnects. The client sends `refresh_live_view` five
  minutes before expiry. A probe with `close: true` is how 关闭浏览器 and conversation deletion end
  a session.
- Session lifetime is the platform's idle timer: `keep_alive` is 10 minutes, the maximum, and
  nothing server-side extends it. The model's own CDP commands count as activity, so a session
  outlives a turn by at most 10 minutes. A mounted Live View frame also counts as activity, so
  the client unmounts it after `LIVE_VIEW_IDLE_MS` (10 minutes) without a person touching the
  panel — a click or key in the panel, focus entering the frame, the pointer crossing the
  frame's edge, or a session event; each counts once, never as a standing state — and whenever the
  page is hidden. The tab shows the countdown and a 恢复画面 button; resuming sends `state`, which
  either mints a fresh link or reports the session gone. Each device keeps its own timer, so a
  session lives while any device is using it and is reclaimed at most 20 minutes after the last.
- Cloudflare's own `Cloudflare.handoff` command is not used: its completion event needs a standing
  CDP connection, and the panel already shows instructions and buttons.

## Human-answered tools

`runToolRespond` currently accepts only `ask_user`. It becomes generic: a tool registration may
carry `respond(input, result) => validated`, the hub looks the validator up by tool name, and
`ask_user` and `browser_handoff` each supply their own. `awaitsHumanToolResult` already stops the
generation for any tool without `execute`.

## Workspace Panel

The core owns a panel shell in the chat view; plugins own tabs.

- **Manifest** declares `workspaceTab: { label, icon? }`, at most one per plugin. The shell lists
  tabs of plugins that are globally enabled and usable in this conversation, so a conversation
  outside a Project shows no panel.
- **Client registration** `ctx.workspacePanel.register(component)`; the plugin is loaded when its
  tab is first activated. The component receives `conversationId` and `projectId`.
- **Attention** `ctx.workspacePanel.attention({ open })`. The browser plugin calls it when a session
  becomes active and when a handoff arrives. Policy lives in the shell: auto-open at most once per
  session, never after the user collapsed the panel by hand, always on handoff.
- **Layout**: desktop right column, resizable, minimum 320 px, default 40 %, collapsed state in
  localStorage; mobile a full-height bottom sheet built on the existing responsive overlay.
- **Files tab**: the workspace-files plugin registers its existing file panel component. The files
  dialog is removed and the header button opens the panel on that tab.
- **Browser tab**: the Live View iframe while a session is active; a status bar with elapsed time,
  profile scope and 关闭浏览器; an empty state otherwise. A pending handoff shows the instructions
  and the 完成 / 失败 buttons above the iframe.
- **Tool cards**: `browser_use` shows collapsed code, live logs while running, then the result,
  screenshot thumbnails and final URL. `browser_handoff` shows the instructions, the state, and the
  same two buttons.
- **Later**: a bottom slot for the Sandbox terminal, registered the same way.

## Per-conversation plugin settings

`conversations.plugin_settings` (JSON, keyed by plugin id) is added by a D1 migration. A manifest
may declare `conversationConfigSchema` (zod) and `conversationConfig` (field list in the existing
`PluginConfigField` shape); the core renders the fields in conversation settings and validates reads
and writes through the schema. `browser_profile` is the first such setting.

## Errors and limits

Results follow the tavily convention: `{ error }` for a failure, `{ refused }` for a platform limit,
and the UI does not paint a refusal red.

| Situation | Result |
| --- | --- |
| Code fails to load | `error` with message and line |
| Code throws | `error` with message, trimmed stack, logs so far, one automatic screenshot |
| Timeout | `error`, `timedOut: true`, logs so far |
| Browser Run 429 | `refused` with the Retry-After value |
| Session gone between calls | relaunched silently; `error` only if the relaunch fails |
| Dynamic Worker CPU limit | `error` |
| Generation aborted | run cancelled through `signal`; the browser is disconnected, not closed |

Limits: code 32 KiB; timeout default `default_timeout_ms`, maximum 300 s; returned logs 16 KiB;
8 screenshots per run. Nothing is dropped silently; every truncation is marked. There is no separate
per-turn call budget: `TOOL_MAX_STEPS` already bounds a turn.

## Configuration and deployment

- Plugin config: `keep_alive_ms` (default 600000, max 600000) and `default_timeout_ms`
  (default 120000, max 300000). No secrets; `configured` is always true.
- `wrangler.jsonc`: `browser: { binding: "BROWSER", remote: true }`,
  `worker_loaders: [{ binding: "LOADER" }]`, and a self service binding `BROWSER_RUNNER` to the
  `BrowserRunner` entrypoint. `remote: true` is required for a real browser in `vite dev`; local
  development counts against the account's browser hours.
- `pnpm dev` and `pnpm build` run `scripts/build-browser-runtime.ts` first; its output under
  `public/browser-runtime/` is generated and ignored by git.

## Tool naming

Provider constraints: Anthropic `^[a-zA-Z0-9_-]{1,128}$`, OpenAI `^[a-zA-Z0-9_-]{1,64}$`, Gemini
letters, digits, `_ . : -`, 64 max. Model-facing names therefore use `[a-zA-Z0-9_-]` and at most 64
characters. `__` is reserved as the namespace separator and may not appear inside a plugin or tool
id. Built-in tools keep bare names. MCP tools, when they arrive, are renamed once at import to
`mcp__<server>__<tool>` (invalid characters replaced, overlong names truncated with a short hash),
and that generated name is what conversations persist and models see.

## Testing

- Pure: code validation and hashing, result assembly and truncation, profile key selection, the
  panel's auto-open policy.
- Gateway: a connect to another session id is refused.
- `tool.respond`: existing `ask_user` tests unchanged; one case for `browser_handoff` validation.
- Client host: `workspacePanel` registration and `attention` forwarding.
- Real browsers are not part of the unit suite. Smoke test against `vite dev` with `remote: true`:
  one run, one reconnect after idle, one handoff.

## Acceptance criteria

- In a Project conversation the model can run Playwright code against a browser that keeps its
  tabs and cookies across calls; outside a Project the tools are not offered.
- Model code has no network access and cannot open a second browser.
- The panel shows the live browser while a session exists, opens itself once, and the human can
  intervene at any time.
- A handoff pauses the generation, the human finishes in the Live View, and the generation resumes
  with the outcome.
- Login state survives across conversations of the same Project by default and can be scoped per
  conversation setting.
- Screenshots reach the model as media only while the call's generation is running; the persisted
  result carries attachment ids, never bytes.
- Every limit is visible in the result; nothing is truncated silently.
- The files dialog is replaced by the files tab without losing any capability.
