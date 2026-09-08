# Provider Settings Redesign

## Goal

Reorganize provider settings around progressive disclosure so common connection settings and model management remain easy to scan, while multi-protocol configuration and detailed model metadata move into secondary overlays.

The model list must also distinguish models discovered from the provider from models explicitly retained by the user, support bulk enablement, and preserve enabled models that disappear from the provider catalog.

## Scope

- Redesign `/settings/providers/:id` using the existing three-pane desktop shell.
- Keep the model picker provider quick editor compact and reusable.
- Move multi-interface provider configuration into a secondary overlay.
- Reorganize model editing into common and advanced sections.
- Add provider-list provenance and availability state to stored models.
- Add provider-wide and Lab-scoped bulk enable/disable operations.
- Preserve enabled provider models that disappear upstream and communicate that state.

## Non-goals

- Do not add model task types in this change.
- Do not implement image or video generation tools.
- Do not infer that image output capability makes a model chat-compatible.
- Do not make models.dev authoritative for provider membership.
- Do not change provider credentials, endpoint ownership, or catalog matching rules.

## Page Structure

### Desktop

The existing provider navigation remains in pane two. Pane three contains:

1. Provider header
   - saved provider name;
   - request-settings action;
   - provider enabled switch;
   - unsaved-change and background-refresh status.
2. Connection section
   - API Key input;
   - the default interface Base URL;
   - an “add endpoint” action;
   - a request-configuration action.
3. Model section
   - search and capability filters;
   - fetch-models action;
   - manual model input;
   - enable-all and disable-all actions;
   - collapsible Lab groups;
   - compact model rows.
4. Sticky save bar
   - explicit save action;
   - unsaved-change state;
   - provider deletion remains a secondary destructive action.

The page retains existing content while background reads are running. Refreshing must not replace populated content with skeletons.

### Mobile

The same content is rendered as one scrollable page. Sticky actions account for the bottom safe area. Request configuration and model editing use mobile drawers with scrollable content and safe-area padding.

## Provider Connection Editing

`ProviderSettingsForm` remains the shared connection form boundary. It supports full-page and compact presentation without duplicating provider field behavior.

The full page directly exposes only:

- API Key;
- default interface Base URL;
- add-endpoint action;
- request-configuration action.

The provider quick editor opened from the model picker remains a centered Dialog. It exposes:

- enabled state;
- provider name;
- API Key;
- default interface Base URL;
- request-configuration action;
- link/action to the full provider settings page.

It does not render the provider model list.

## Request Configuration Overlay

Request configuration uses a right-side Sheet on desktop and a bottom Drawer on mobile.

Each configured protocol is rendered as a compact endpoint card containing:

- protocol name;
- Base URL;
- native Files capability where supported;
- current-default badge;
- set-default action;
- remove action.

The overlay also contains:

- add-interface action for unused protocols;
- models.dev manual association in an advanced section;
- cancel and apply actions.

The overlay edits an isolated draft. “Apply” copies that draft into the parent provider draft but does not write to the server. The page-level sticky save action is the only persistence action. Closing an unapplied overlay draft requires confirmation.

## Model List

Models are grouped by configured provider and then Lab using the existing catalog-derived `lab_id`. Within a provider settings page the provider heading is omitted and Lab groups remain visible. The unmatched group is named “其他”.

Each Lab group:

- is collapsible;
- shows its human-readable Lab name and icon;
- shows enabled and total counts;
- provides enable-group and disable-group actions.

The model toolbar provides provider-wide enable-all and disable-all actions. Bulk operations apply to the full provider or Lab group, not only the visible page or current search result.

Each model row contains:

- Lab icon;
- human-readable name;
- provider model ID;
- capability badges;
- availability/provenance badge when applicable;
- enabled switch;
- edit action;
- remove action where applicable.

New models discovered from `/models` are disabled by default.

## Model Provenance and Availability

The `models` table adds:

- `manual_pinned boolean not null`;
- `upstream_available boolean null`.

The existing `(provider_id, model_id)` identity remains unique. Provenance and availability are independent states rather than mutually exclusive sources.

### State Meaning

| `manual_pinned` | `upstream_available` | Meaning |
| --- | --- | --- |
| `true` | `null` | Manually retained and not yet compared with `/models` |
| `true` | `true` | Manually retained and currently advertised upstream |
| `true` | `false` | Manually retained but absent upstream |
| `false` | `true` | Discovered and currently advertised upstream |
| `false` | `false` | Discovered upstream previously, now removed |

Existing rows are migrated with `manual_pinned = true` and `upstream_available = null` because their original provenance cannot be reconstructed safely.

### Refresh Transition Rules

For a successful `/models` response:

1. New ID
   - insert once;
   - `enabled = false`;
   - `manual_pinned = false`;
   - `upstream_available = true`.
2. Existing returned ID
   - set `upstream_available = true`;
   - preserve enabled state, interface selection, ordering, metadata overrides, and `manual_pinned`.
3. Missing, enabled, unpinned model
   - retain the row;
   - set `upstream_available = false`;
   - show an orange warning badge indicating that the provider removed it.
4. Missing, disabled, unpinned model
   - delete the row.
5. Missing, manually pinned model
   - retain the row;
   - set `upstream_available = false`;
   - show a neutral “手动” badge rather than the provider-removed warning.
6. Previously missing model that reappears
   - set `upstream_available = true`;
   - remove the warning state.

A failed `/models` request changes no availability flags and deletes no rows.

### Manual Add Collision

Manually adding an existing `(provider_id, model_id)` updates that row instead of inserting a duplicate:

- set `manual_pinned = true`;
- preserve enabled state, interface selection, ordering, metadata overrides, and availability state;
- if the model was retained as removed, the neutral manual badge replaces the removal warning.

Disabling an unpinned, unavailable model deletes it immediately. Disabling a manually pinned model retains it.

## Bulk Model Operations

Add one provider-scoped bulk endpoint that accepts:

- target provider ID from the route;
- optional `lab_id` scope;
- desired `enabled` state.

The operation runs as bounded D1 statements rather than one HTTP request per model.

Enabling updates every matching row. Disabling:

- deletes unavailable, unpinned matching rows;
- disables all other matching rows.

The response returns affected counts. The client then refreshes the current provider model query while preserving search, filter, and collapsed-group state.

Indexes must support provider-scoped and provider-plus-Lab operations without scanning unrelated providers.

## Model Editor

Model editing uses a right-side Sheet on desktop and a bottom Drawer on mobile.

The initial view contains:

- model ID;
- display name;
- effective provider interface;
- enabled state;
- capabilities;
- input and output modalities.

“更多设置” is collapsed by default and contains:

- context and token limits;
- pricing;
- reasoning options;
- interleaved reasoning configuration;
- remaining informational overrides.

The raw JSON editor remains the final advanced entry point. It displays editable user overrides separately from read-only effective metadata, warns that invalid data can cause unexpected behavior, and blocks saving on JSON syntax or metadata-schema errors.

The layout reserves a distinct future model-task section. A later schema can add tasks such as `chat`, `image-generation`, `image-edit`, and `video-generation` without overloading modalities.

## Save and Dirty-state Semantics

- Provider settings retain explicit save semantics.
- Page fields and applied request-configuration changes form one provider draft.
- The sticky save bar is the only server persistence action on the full page.
- Navigating away with a dirty provider draft requires confirmation.
- Closing request configuration with unapplied changes requires confirmation.
- Model edits retain their independent save and dirty-state guard.
- Successful saves acknowledge only the submitted snapshot; edits made while a request is pending remain dirty.

## Concurrency and Failure Handling

- Provider, catalog, model-list, single-model, and bulk writes retain their existing destination IDs and source revisions.
- A delayed response cannot repaint a newer provider, filter, association, or model draft.
- Fetch-model reconciliation runs only after a complete successful upstream response.
- Model list refreshes preserve populated content and show progress in the toolbar.
- A bulk mutation refreshes only if its provider and query generation remain current.
- Catalog metadata rematerialization and provider membership reconciliation remain separate operations.
- Errors appear in the owning surface and never clear the previous successful list.

## Visual and Accessibility Requirements

- Use existing shadcn-vue components and semantic colors.
- Provider removal uses a warning-semantic badge; manually retained state uses an outline badge.
- Every icon action has an accessible name and at least a 40px touch target on mobile.
- Group headers expose expanded state and bulk actions to assistive technology.
- Sheets and Drawers contain accessible titles and restore focus to their trigger.
- Sticky actions and mobile drawers include safe-area padding.
- Keyboard navigation through model rows remains compatible with Command/Listbox semantics where used.

## Verification

Automated tests cover:

- provider form reuse and compact/full variants;
- request-configuration apply, cancel, and dirty guards;
- new fetched models defaulting to disabled;
- returned, removed, reappearing, and manually pinned model transitions;
- manual-add collisions;
- provider-wide and Lab-scoped bulk enable/disable;
- failed refreshes preserving stored state;
- stale response fencing;
- model editor progressive disclosure and raw JSON validation;
- query/filter behavior with new state fields.

Native browser verification covers:

- desktop three-pane provider settings;
- mobile provider settings;
- request-configuration Sheet/Drawer;
- large grouped model lists and collapse state;
- provider-wide and group-scoped actions;
- removed/manual badges;
- sticky save behavior;
- model editor common and advanced sections.

## Acceptance Criteria

- The full provider page exposes common connection settings without displaying every protocol field inline.
- Multi-protocol changes are staged through request configuration and persisted only by the page save action.
- Models fetched for the first time are disabled.
- Bulk enable/disable works for a provider and a Lab independently of pagination.
- Enabled removed models remain visible with a warning; disabling them removes unpinned rows.
- Disabled removed models disappear after a successful refresh.
- Manual models survive upstream absence and ID collisions without losing configuration.
- Existing provider/model draft and concurrency guarantees remain intact.
- Desktop and mobile overlays use the approved Sheet/Drawer behavior and preserve accessibility.
