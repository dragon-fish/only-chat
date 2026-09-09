# Ask User Plugin

## Purpose

`ask_user` is the first built-in feature plugin. It validates the shared plugin registry, stable per-Conversation tool configuration, cross-protocol tool calls, durable human input, client Part rendering, and generation continuation.

## Plugin registry

Feature plugins live under `src/plugins/<plugin-id>/` with optional `client/` and `server/` entrypoints plus shared files:

- `manifest.ts` exports lightweight display metadata and default tool IDs;
- `shared.ts` owns wire schemas and types;
- `client/index.ts` exports `setup(ctx)` and registers Vue renderers or controls;
- `server/index.ts` exports a Cordis plugin and registers AI SDK tools or command handlers.

The client eagerly discovers only manifests with `import.meta.glob`; it keeps client entrypoints as lazy loaders. A client plugin chunk loads when the plugin is enabled, a Conversation selects one of its tools, or historical Parts require its renderer. The server deploys all built-in server entrypoints in the Worker bundle and uses Cordis lifecycle registration.

Client rendering is declarative: a tool registry maps tool IDs to Vue components and schemas. Global hooks are available for side effects but never act as the source of truth for a card that must survive reloads.

This version does not expose a global RLQ or load external URLs. A future classic-script adapter may forward queued `setup(ctx)` functions into the same client host without changing plugin APIs.

Settings render from the discovered manifests; database settings only store whether each plugin is globally enabled. The first built-in plugin is `ask_user`.

Unknown plugin and tool IDs fail closed. Registries return tools in stable ID order so request prefixes do not change between turns.

## Global and Conversation state

Conversations add a non-null JSON `tools` array with an empty-array default. Existing Conversations therefore keep their current tool-free request prefix.

Enabling a plugin changes only the defaults for newly drafted Conversations. A new draft starts with every tool from globally enabled plugins selected. The first `send` persists that selected list atomically with Conversation creation.

Existing Conversations read their own stored list. Users may change it from the Composer tool selector; that explicit change is allowed to invalidate the Conversation's model prefix cache. Enabling another plugin globally never edits existing Conversation rows.

Globally disabling a plugin removes its tools from subsequent model requests while retaining the stored Conversation selection. Re-enabling the plugin restores the selection. Pending calls created before disablement remain answerable or cancellable.

The Composer's left controls contain a tool button with the selected count. It opens a Popover on desktop and a Drawer on mobile. Each available plugin tool has a Switch, title, and description. A selected tool that the current model cannot call blocks sending with a clear model-capability message.

## Tool schema

`ask_user` is registered as an AI SDK tool without an `execute` function. Its input contains one to three questions.

Each question contains:

- stable `id`;
- short `header`;
- full `question`;
- `type`: `single`, `multiple`, or `text`;
- optional explanatory `description`;
- optional text `placeholder`;
- two to nine `options` for choice questions, each with `label` and optional `description`;
- optional `allowOther` for choice questions, defaulting to `true`;
- optional `required`, defaulting to `false`.

IDs must be unique within one call. Choice options are forbidden for text questions and required for choice questions. The schema is strict and shared between the AI tool and client renderer.
The tool guidance tells the model to ask a lone open-ended question in normal chat. Text questions
remain available when batching multiple questions so the user can submit every answer together.

## Generation behavior

Before `streamText`, the server resolves the Conversation tool snapshot against the globally enabled plugin registry and the selected model's declared tool capability. It passes the resulting tools in stable ID order.

Because `ask_user` has no `execute`, a model call that emits it finishes the current generation normally. The assistant Message persists its `tool_call` Part and remains `done`. An unmatched `tool_call` is the complete durable waiting state; no Worker invocation, Durable Object task, Queue message, or Workflow remains active while waiting for a person.

Multiple calls in one assistant Message are allowed. Generation continues only after every call has a terminal result and none was cancelled.

## Questionnaire rendering

The client renders the current unmatched `ask_user` call in place of the Composer. The assistant
Message keeps a compact waiting indicator; answered and cancelled calls render their durable summary
in the Message. Replacing the Composer hides but does not discard an existing local draft.

- Questions are shown one at a time.
- Single-choice answers use radio choices.
- Multiple-choice answers use checkbox choices.
- Text answers use Questionnaire input.
- Choice questions show one “其他” input unless `allowOther` is explicitly `false`; multiple choice
  may combine it with preset values. Preset choices guide the UI and do not whitelist results.
- Choice shortcuts use Questionnaire's numeric mode.
- The first answer receives focus so a numeric shortcut followed by Enter can advance or submit.
- Back/next/skip/progress controls use the bundled Questionnaire components. Optional questions may
  be skipped; required questions cannot.
- Answers are submitted together after the last question.
- Partial answers remain local and are discarded on full-page reload.

An answered card becomes a compact read-only summary. A cancelled card becomes a compact “用户取消了回答” state. Terminal cards cannot be submitted again.

## Tool results

The client sends a `tool.respond` WebSocket command containing:

- `request_id`;
- assistant `message_id`;
- `call_id`;
- either an answered result or cancelled result.

Answered result:

```json
{
  "status": "answered",
  "answers": [
    { "id": "framework", "value": "Vue" },
    { "id": "features", "value": ["缓存", "工具"] },
    { "id": "budget", "value": null }
  ]
}
```

Answered results contain exactly one ordered entry per question. `null` means that the user skipped
that question. A result in which every value is `null` is complete and resumes generation
immediately; cancelling the whole Questionnaire uses the separate `cancelled` result and stops.

Cancelled result:

```json
{
  "status": "cancelled",
  "message": "用户选择了取消回答"
}
```

The server verifies ownership, finds the matching unresolved call, validates ordered IDs, required
questions, and value shapes against the original call arguments, and atomically appends one
`tool_result` to the Message's JSON Parts only when that call has no result. Choice values outside
the advertised options are preserved for the model. The conditional D1 update is the exactly-once
fence. A repeated identical command is idempotent; a conflicting second result is rejected.

The server broadcasts the appended result through `message.part`, so every connected client closes the same card. Reloads receive it through the existing messages API.

## Continue or cancel

After an answered result is stored, the server checks all tool calls in that assistant Message:

- unresolved calls keep the Conversation waiting;
- any cancelled result stops continuation;
- all answered results start one continuation.

Continuation uses the existing Conversation/project/model resolution. It creates a new assistant shell whose parent is the tool-call Message and generates with the path including the appended tool results. `assembleContext` accepts any leaf Message ID rather than assuming the leaf is a user Message.

Continuation is retry-safe. If the response was already stored, the handler checks for an existing child assistant shell before creating one. A crash after shell creation uses the existing interrupted-shell behavior and can be regenerated. An answered card that is still the Conversation head and has no child assistant exposes a “继续” recovery action; it sends `tool.continue`, which performs the same idempotent child check and continuation without rewriting the tool result.

Cancellation stores the tool result but does not create a child assistant. The next ordinary user Message may use the cancelled tool result as historical context. Verified protocol serialization is:

- Chat Completions: `user → assistant(tool_calls) → tool(cancelled) → user`;
- Responses: `user → function_call → function_call_output(cancelled) → user`;
- Anthropic: `user → assistant(tool_use) → user[tool_result, text]`.

The current client blocks ordinary sends while a valid `ask_user` call is pending. A stale or
multi-device client may still bypass that guard. When its parent is still the Conversation head, the
server atomically appends cancelled results for every pending `ask_user` call with the message
“用户跳过了问题并继续回复”, broadcasts those Parts, and then accepts the user Message. A concurrent
explicit answer and this implicit skip use the same exactly-once fence: whichever persists first
wins, and the losing command must resync instead of creating a second continuation branch.

## Error handling

- Invalid tool arguments are persisted as a visible generation error, not rendered as an interactive form.
- Unknown, disabled, or unselected tools are never sent to the model.
- Invalid answers leave the Questionnaire editable and return a correlated error.
- Disconnects do not clear persisted pending calls or local completed results.
- A response to a foreign Conversation, unknown call, already-conflicting result, or streaming Message fails without mutation.
- Unknown, invalid, or incomplete tool calls are never implicitly cancelled by an ordinary send.
- Pending calls remain resolvable after the plugin is globally disabled.

## Verification

Tests cover product-owned behavior:

- plugin catalog/default selection and stable tool ordering;
- Conversation tool snapshot creation and updates without rewriting existing Conversations;
- strict `ask_user` arguments and answer validation;
- tool-call stream persistence without server execution;
- atomic exactly-once result append and duplicate/conflict behavior;
- answer continuation, cancellation without continuation, multiple-call gating, and reconnect reads;
- current Chat, Responses, and Anthropic tool-result replay ordering;
- Questionnaire answer serialization and terminal rendering;
- desktop/mobile tool selector behavior and numeric shortcuts.

Third-party AI SDK and Questionnaire internals are not unit-tested.
