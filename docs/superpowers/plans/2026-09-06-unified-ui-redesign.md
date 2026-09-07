# Unified UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MVP client shell and every existing page with one responsive shadcn-vue interface while preserving the current stores, APIs, WebSocket commands, persistence model, and generation behavior.

**Architecture:** Use the official `@shadcn/dashboard-01` block as the structural reference for `SidebarProvider`, `Sidebar`, `SidebarInset`, and the route header, then compose only-chat-specific navigation and page components around the existing Pinia stores. Desktop renders dynamic chat/Project sidebars and a three-pane settings workspace; mobile renders route-level lists with a global bottom navigation and swaps that navigation for the Composer inside a concrete chat.

**Tech Stack:** Vue 3.5, Vue Router 5 file routes, Pinia 4, Pug SFC templates, TypeScript 6, Tailwind CSS 4, shadcn-vue 2.8 / reka-ui, Lucide Vue, Vitest 4, Vite 8.

**Spec:** `docs/superpowers/specs/2026-09-06-unified-ui-redesign.md`

## Global Constraints

- Do not change D1 schema, Worker APIs, WebSocket schemas, LLM protocol behavior, or server-side data semantics.
- `project_id = null` is shown as “随心聊”; do not create a default Project record.
- `/` redirects to `/new` at `md` and above and `/chats` below `md` through a functional `definePage` redirect. Desktop brand/home links and the global `＋` open `/new`; unprojected sessions use `/c/:sessionId`. `/project/:projectId` owns a nested RouterView with index, `settings`, `new`, and `c/:sessionId` children. Remove old Project/query routes without aliases or redirects based on session membership.
- Model/session editors use desktop `Sheet` and mobile `Drawer`; model selection and reasoning use desktop `Popover` and mobile `Drawer`. Project settings uses desktop `Dialog` and mobile full-screen `Dialog`, returning to its workspace on close/save. Destructive and unsaved-change confirmations use `AlertDialog`.
- Desktop chat header shows the full model selector. Mobile Project chat header shows Project identity plus an icon-only model selector; reasoning appears only in the Composer.
- Project assistant messages use the Project placeholder avatar/name with the actual model as secondary text. 随心聊 assistant messages use the model identity.
- Theme values are exactly `system | light | dark`, default to `system`, and use semantic CSS tokens only.
- Use existing shadcn-vue components before custom markup. Forms use `FieldGroup` and `Field`; lists use `Item` or `SidebarMenu`; empty/loading/error states use `Empty`, `Skeleton`, `Alert`, and Sonner.
- Do not overwrite installed shadcn-vue primitives without inspecting CLI `--dry-run` and `--diff` output first.
- Preserve one vertical scroll owner per fixed-height region and keep mobile touch targets at least 40 CSS px.
- Do not edit or stage the pre-existing working-tree-only changes in `src/client/typed-router.d.ts` and `test/unit/__snapshots__/llm-messages.test.ts.snap` unless a task legitimately regenerates them; review their final diff separately before staging.

---

## File Structure

### New files

- `src/client/lib/ui-models.ts` — pure Project activity, recent-Project, navigation search, and model-filter functions.
- `src/client/lib/theme.ts` — theme parsing, resolution, DOM application, persistence, and system-media subscription.
- `src/client/composables/use-theme.ts` — reactive Vue wrapper around `theme.ts`.
- `src/client/components/layout/app-sidebar.vue` — desktop shadcn Sidebar host that switches between outer chat, Project, and settings navigation.
- `src/client/components/layout/chat-sidebar-content.vue` — outer and Project desktop sidebar content.
- `src/client/components/layout/settings-sidebar-content.vue` — first-level desktop settings navigation.
- `src/client/components/layout/mobile-bottom-nav.vue` — mobile `[聊天][＋][设置]` navigation.
- `src/client/components/layout/route-header.vue` — shared desktop/mobile header slots.
- `src/client/components/layout/responsive-overlay.vue` — a controlled Sheet/Drawer host with a Dialog mode for desktop/mobile-full-screen Project settings.
- `src/client/components/project-avatar.vue` — deterministic Project initial/fallback avatar.
- `src/client/components/provider-avatar.vue` — deterministic provider/model initial fallback avatar.
- `src/client/components/provider-navigation.vue` — searchable configured-provider list used by desktop settings and mobile model-service page.
- `src/client/components/model-editor.vue` — model form body shared by Sheet and Drawer.
- `src/client/views/projects-index.vue` — all-Projects page.
- `src/client/views/project-sessions.vue` — one Project’s mobile conversation list.
- `src/client/views/chat-index.vue` — Project-first chat/Project list for the mobile home route.
- `src/client/views/settings-index.vue` — mobile settings-category page and desktop blank/default state.
- `src/client/views/settings-appearance.vue` — theme selector.
- `src/client/pages/projects/index.vue` — `/projects` route adapter.
- `src/client/pages/new.vue` — unprojected draft.
- `src/client/pages/project/[projectId].vue` — Project parent with nested RouterView and Project context.
- `src/client/pages/project/[projectId]/{index,new,settings}.vue`, `src/client/pages/project/[projectId]/c/[sessionId].vue` — Project child route adapters.
- `src/client/pages/chats/index.vue` — `/chats` route adapter.
- `src/client/pages/settings/index.vue` — `/settings` route adapter.
- `src/client/pages/settings/appearance.vue` — `/settings/appearance` route adapter.
- `test/unit/client-ui-models.test.ts` — pure navigation/model picker tests.
- `test/unit/client-theme.test.ts` — pure theme tests.

### Major modified files

- `index.html`, `src/client/main.ts`, `src/client/style.css`, `src/client/styles/main.scss` — pre-mount theme, tokens, safe areas, and root sizing.
- `src/client/app.vue`, `src/client/components/app-shell.vue` — block-derived application chassis and global feedback.
- `src/client/views/chat.vue`, `model-picker.vue`, `message-list.vue`, `message-item.vue`, `composer.vue`, `session-settings.vue`, `reasoning-control.vue` — chat experience.
- `src/client/views/settings-providers.vue`, `settings-provider-edit.vue`, `settings-plugins.vue`, `project-settings.vue` — unified settings surfaces.
- `src/client/pages/settings/providers/index.vue`, `src/client/pages/settings/providers/[id].vue`, `src/client/pages/settings/plugins.vue`, `src/client/pages/project/[projectId]/settings.vue` — route adapters that select the correct desktop/mobile workspace.

---

### Task 1: Theme Core and First-Paint Theme Application

**Files:**
- Create: `src/client/lib/theme.ts`
- Create: `src/client/composables/use-theme.ts`
- Create: `test/unit/client-theme.test.ts`
- Modify: `index.html`
- Modify: `src/client/main.ts`
- Modify: `src/client/style.css`

**Interfaces:**
- Produces: `type ThemePreference = 'system' | 'light' | 'dark'`.
- Produces: `parseThemePreference(raw: string | null): ThemePreference`.
- Produces: `resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark'`.
- Produces: `applyTheme(preference: ThemePreference): () => void`, returning an unsubscribe function.
- Produces: `useTheme(): { preference: Ref<ThemePreference>; resolved: ComputedRef<'light' | 'dark'>; setPreference(value: ThemePreference): void }`.

- [ ] **Step 1: Write failing theme resolver tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseThemePreference, resolveTheme } from '@/client/lib/theme'

describe('theme preference', () => {
  it('accepts only the three persisted values', () => {
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('sepia')).toBe('system')
    expect(parseThemePreference(null)).toBe('system')
  })

  it('resolves system without changing explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm vitest run test/unit/client-theme.test.ts`

Expected: FAIL because `@/client/lib/theme` does not exist.

- [ ] **Step 3: Implement theme parsing and DOM application**

```ts
export const THEME_STORAGE_KEY = 'oc.theme'
export type ThemePreference = 'system' | 'light' | 'dark'

export function parseThemePreference(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

export function applyResolvedTheme(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}

export function applyTheme(preference: ThemePreference): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const sync = () => applyResolvedTheme(resolveTheme(preference, media.matches))
  sync()
  if (preference === 'system') media.addEventListener('change', sync)
  return () => media.removeEventListener('change', sync)
}
```

Implement `use-theme.ts` with one module-level preference ref, replace the active media listener whenever `setPreference` runs, and write only `oc.theme` to local storage.

- [ ] **Step 4: Add a pre-mount theme script**

In `index.html`, place an inline script before the module entry that reads `oc.theme`, resolves `matchMedia('(prefers-color-scheme: dark)')`, toggles `.dark`, and sets `style.colorScheme`. Keep this script dependency-free so the first painted frame already has the correct theme.

- [ ] **Step 5: Replace raw status colors with semantic tokens**

Add named semantic status variables to both `:root` and `.dark` in `src/client/style.css` (`--success`, `--success-foreground`) and expose them through `@theme inline`. Do not add page-specific `dark:` overrides.

- [ ] **Step 6: Run focused verification**

Run: `pnpm vitest run test/unit/client-theme.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add index.html src/client/main.ts src/client/style.css src/client/lib/theme.ts src/client/composables/use-theme.ts test/unit/client-theme.test.ts
git commit -m "feat(theme): add first-class color modes"
```

---

### Task 2: Navigation and Model Picker View Models

**Files:**
- Create: `src/client/lib/ui-models.ts`
- Create: `test/unit/client-ui-models.test.ts`
- Modify: `src/client/stores/config.ts` only if an exported model-entry type is needed.

**Interfaces:**
- Produces: `projectActivity(project: Project, sessions: readonly Session[]): number`.
- Produces: `recentProjects(projects: readonly Project[], sessions: readonly Session[], limit?: number): Project[]`.
- Produces: `searchProjects(projects: readonly Project[], query: string): Project[]`.
- Produces: `searchSessions(sessions: readonly Session[], query: string, projectId?: number | null): Session[]`.
- Produces: `type ModelCapabilityFilter = 'all' | 'vision' | 'reasoning' | 'tools' | 'image_output'`.
- Produces: `type EnabledModelEntry = { provider: Provider; model: Model }`.
- Produces: `filterModelEntries(entries: readonly EnabledModelEntry[], query: string, capability: ModelCapabilityFilter): EnabledModelEntry[]`.

- [ ] **Step 1: Write failing Project ordering and search tests**

```ts
import type { Model, ModelCapabilities, Project, Provider, Session } from '@/shared/models'

const project = (id: number, updated_at: number): Project => ({
  id, user_id: 1, name: `Project ${id}`, system_prompt: null,
  provider_id: null, model_id: null, params: null,
  created_at: updated_at, updated_at,
})

const session = (id: number, project_id: number | null, updated_at: number, title = `Session ${id}`): Session => ({
  id, user_id: 1, project_id, title, head_message_id: null,
  provider_id: null, model_id: null, system_prompt: null, params: null,
  created_at: updated_at, updated_at, archived_at: null,
})

const entry = (providerName: string, model_id: string, display_name: string, capabilities: ModelCapabilities) => ({
  provider: { id: providerName.length, user_id: 1, name: providerName, protocol: 'openai-responses', base_url: '', enabled: true, has_key: true, native_files: false, extra: null, created_at: 0 } satisfies Provider,
  model: { id: model_id.length, provider_id: providerName.length, model_id, display_name, capabilities, pricing: null, enabled: true, sort: 0 } satisfies Model,
})

it('orders Projects by their newest own or child-session activity and limits to five', () => {
  const projects = [project(1, 10), project(2, 20), project(3, 30), project(4, 40), project(5, 50), project(6, 60)]
  const sessions = [session(1, 1, 100), session(2, 2, 90)]
  expect(recentProjects(projects, sessions).map(p => p.id)).toEqual([1, 2, 6, 5, 4])
})

it('scopes session search when a Project id is supplied', () => {
  const sessions = [session(1, 7, 30, 'Design notes'), session(2, null, 20, 'Design question')]
  expect(searchSessions(sessions, 'design', 7).map(s => s.id)).toEqual([1])
  expect(searchSessions(sessions, 'design').map(s => s.id)).toEqual([1, 2])
})
```

- [ ] **Step 2: Write failing model filter tests**

```ts
it('matches provider, display name, model id, and declared capabilities', () => {
  const entries = [
    entry('ZenMux', 'google/gemini', 'Gemini Flash', { vision: true }),
    entry('DeepSeek', 'deepseek-chat', 'DeepSeek V4', { reasoning: true }),
  ]
  expect(filterModelEntries(entries, 'zen', 'all')).toEqual([entries[0]])
  expect(filterModelEntries(entries, 'deepseek-chat', 'reasoning')).toEqual([entries[1]])
  expect(filterModelEntries(entries, '', 'vision')).toEqual([entries[0]])
})
```

- [ ] **Step 3: Run the focused test and verify failure**

Run: `pnpm vitest run test/unit/client-ui-models.test.ts`

Expected: FAIL because `ui-models.ts` does not exist.

- [ ] **Step 4: Implement the pure selectors**

Use the numeric `updated_at` values directly for activity, lower-case trimmed substring matching for search, a default Project limit of `5`, stable descending order with Project id as the final tie-breaker, and capability checks that read only `model.capabilities[capability] === true`.

Do not infer capabilities from model ids. `searchSessions(..., undefined)` means all sessions; explicit `null` means only 随心聊; a number means only that Project.

- [ ] **Step 5: Run focused verification**

Run: `pnpm vitest run test/unit/client-ui-models.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/lib/ui-models.ts src/client/stores/config.ts test/unit/client-ui-models.test.ts
git commit -m "feat(ui): add navigation view models"
```

---

### Task 3: Block-Derived Application Chassis

**Files:**
- Create: `src/client/components/layout/app-sidebar.vue`
- Create: `src/client/components/layout/route-header.vue`
- Create: `src/client/components/layout/mobile-bottom-nav.vue`
- Modify: `src/client/components/app-shell.vue`
- Modify: `src/client/app.vue`
- Modify: `src/client/styles/main.scss`

**Interfaces:**
- `AppSidebar` consumes the current route plus `useSyncStore()` and renders a named slot/content component selected by route context.
- `RouteHeader` exposes `leading`, default, and `actions` slots and owns the fixed header height.
- `MobileBottomNav` emits no business events; it navigates to `/chats`, `/new`, and `/settings`. The center link always starts an unprojected draft.
- `AppShell` keeps `bootError?: string | null` and remains the sole viewport-height owner.

- [ ] **Step 1: Inspect the official block without mutating the project**

In PowerShell:

```powershell
$env:NODE_USE_ENV_PROXY='1'
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:HTTP_PROXY=$env:HTTPS_PROXY
pnpm dlx shadcn-vue@latest info --json
pnpm dlx shadcn-vue@latest view @shadcn/dashboard-01
pnpm dlx shadcn-vue@latest add dashboard-01 --dry-run
```

Confirm the block uses `SidebarProvider`, `AppSidebar`, `SidebarInset`, and a header. Do not run `add` without `--dry-run`; do not copy chart/table/demo files.

- [ ] **Step 2: Read the exact component APIs**

Run:

```powershell
pnpm dlx shadcn-vue@latest docs sidebar separator breadcrumb button tooltip
```

Open the returned official documentation URLs and verify the installed Nova/Reka APIs before writing templates.

- [ ] **Step 3: Replace `app-shell.vue` with the block chassis**

Compose `SidebarProvider`, `AppSidebar`, `SidebarInset`, `RouteHeader`, route content, and `MobileBottomNav`. Desktop sidebar is hidden below `md`; mobile bottom navigation is hidden at `md` and above. Draft and session routes (`/new`, `/c/:sessionId`, and their nested Project equivalents) suppress `MobileBottomNav` while displaying the Composer; list/settings routes keep it.

Keep the boot error and `sync.lastError` in the shell, replacing raw paragraphs with `Alert` and a dismiss `Button`. Add one `Toaster` host in `app.vue`.

- [ ] **Step 4: Preserve the viewport/scroll contract**

Keep `html`, `body`, and `#app` at `100dvh` with document overflow hidden. Add bottom safe-area padding to the mobile nav and Composer, and ensure `SidebarInset` plus the route outlet use `min-h-0` and `overflow-hidden`.

- [ ] **Step 5: Verify compilation**

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm build`

Expected: PASS with no missing shadcn imports.

- [ ] **Step 6: Commit**

```bash
git add src/client/app.vue src/client/components/app-shell.vue src/client/components/layout/app-sidebar.vue src/client/components/layout/route-header.vue src/client/components/layout/mobile-bottom-nav.vue src/client/styles/main.scss
git commit -m "feat(ui): rebuild the application chassis"
```

---

### Task 4: Dynamic Chat Navigation and Project Routes

**Files:**
- Create: `src/client/components/layout/chat-sidebar-content.vue`
- Create: `src/client/components/project-avatar.vue`
- Create: `src/client/views/projects-index.vue`
- Create: `src/client/views/project-sessions.vue`
- Create: `src/client/views/chat-index.vue`
- Create: `src/client/pages/projects/index.vue`
- Create: `src/client/pages/project/[projectId].vue` and its index/new/settings/chat children
- Create: `src/client/pages/chats/index.vue`
- Modify: `src/client/components/layout/app-sidebar.vue`
- Replace/remove usage: `src/client/components/session-list.vue`, `src/client/components/project-tree.vue`

**Interfaces:**
- Consumes: `recentProjects`, `searchProjects`, and `searchSessions` from Task 2.
- `ChatSidebarContent` accepts `projectId?: number | null`; `undefined` renders the outer Project-first navigation, a number renders that Project’s replacement navigation.
- `ProjectAvatar` accepts `{ name: string; size?: 'sm' | 'default' }` and always renders `AvatarFallback`.
- `/projects` renders all Projects; `/project/:projectId` renders the Project workspace with a nested RouterView. Its index lists scoped sessions and redirects a confirmed missing Project to `/projects`.
- `/chats` renders the chat/Project list; `/new` always renders the unprojected draft with Composer. `/` uses a functional `definePage` redirect to enter `/new` on desktop and `/chats` on mobile before rendering a page.

- [ ] **Step 1: Implement the outer desktop navigation**

Use `SidebarHeader`, `SidebarContent`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarFooter`, `Collapsible`, `DropdownMenu`, and `ScrollArea`.

Order is fixed: new 随心聊, search, five recent Projects, “查看全部 Projects”, 随心聊 sessions, settings. Project creation uses a Dialog with `FieldGroup`/`Field`; deletion and session deletion use `AlertDialog` rather than the existing two-click state.

- [ ] **Step 2: Implement Project replacement navigation**

Header: back to the outer navigation, Project avatar/name, Project switcher. Body: Project new chat (`/project/:projectId/new`), scoped search, Project settings, Project sessions. Moving sessions uses `DropdownMenu` and existing `moveSessionCommand`.

- [ ] **Step 3: Implement mobile Project pages**

`chat-index.vue` shows the recent five Projects first and 随心聊 sessions second. `projects-index.vue` shows searchable Projects and create action. `project-sessions.vue` shows back, Project identity, Project settings, explicit Project-new-chat action, and scoped sessions. All three pages keep `MobileBottomNav`; opening `/new`, `/c/:sessionId`, or their nested Project equivalents replaces the nav with the Composer.

- [ ] **Step 4: Remove the old tree from the live shell**

Stop importing `SessionList`/`ProjectTree` from `app-shell.vue`. Delete those files only after `rg "SessionList|ProjectTree|session-list|project-tree" src/client` shows no remaining consumers.

- [ ] **Step 5: Run focused verification**

Run: `pnpm vitest run test/unit/client-ui-models.test.ts test/unit/client-sync-store.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/components/layout src/client/components/project-avatar.vue src/client/views/chat-index.vue src/client/views/projects-index.vue src/client/views/project-sessions.vue src/client/pages/chats src/client/pages/projects src/client/pages/project src/client/pages/new.vue src/client/components/app-shell.vue
git add -u src/client/components/session-list.vue src/client/components/project-tree.vue
git commit -m "feat(navigation): add dynamic Project navigation"
```

---

### Task 5: Chat Header, Model Picker, and Message Identity

**Files:**
- Create: `src/client/components/provider-avatar.vue`
- Modify: `src/client/components/model-picker.vue`
- Modify: `src/client/views/chat.vue`
- Modify: `src/client/components/message-list.vue`
- Modify: `src/client/components/message-item.vue`
- Modify: `src/client/ui/message/*` or `src/client/ui/bubble/*` only if a reviewed local primitive defect blocks composition.

**Interfaces:**
- Consumes: `filterModelEntries` and `ModelCapabilityFilter` from Task 2.
- `ModelPicker` keeps `modelValue: ModelRef | null` and `update:modelValue`; add `compact?: boolean` to render icon-only mobile trigger.
- `MessageList` additionally accepts `project?: Project` and resolves the assistant display identity without altering message data.
- `provider-avatar.vue` accepts a display name and uses a deterministic initial fallback; it never guesses a remote logo URL.

- [ ] **Step 1: Read exact component docs**

Run:

```powershell
pnpm dlx shadcn-vue@latest docs command popover drawer toggle-group badge avatar message bubble message-scroller
```

Use the returned official APIs. `CommandItem` must remain inside `CommandGroup`; every Avatar must include `AvatarFallback`; Drawer must include a Title.

- [ ] **Step 2: Replace the Select model picker**

Desktop trigger shows provider/model avatar and full model display name, opening a Popover containing Command search, a `ToggleGroup` capability filter, and provider `CommandGroup`s. The viewport selects Popover or Drawer through one open state; `compact` controls only the trigger appearance. Chat headers mount one picker across breakpoints.

Search provider name, model id, and display name through Task 2’s pure helper. Capability filters use only declared capabilities.

- [ ] **Step 3: Rebuild the chat header**

Desktop: full ModelPicker at the leading edge and SessionSettings at the trailing edge; do not render a reasoning chip. Mobile Project chat: back, Project avatar/name, compact ModelPicker, SessionSettings. Mobile 随心聊: back, fixed title “随心聊”, compact ModelPicker, SessionSettings.

Preserve model inheritance, remembered pick, unavailable-model guard, and restore-inheritance behavior from `chat.vue`.

- [ ] **Step 4: Rebuild message composition**

Use `MessageScroller`, `Message`, and `Bubble`. User messages are right-aligned tinted bubbles. Assistant messages are open/ghost layout with avatar, primary identity, optional actual-model secondary label, Markstream content, reasoning summary, image parts, status, and ghost icon actions.

For Project sessions, primary assistant identity is `project.name`; for 随心聊 it is the actual model display name. Preserve `assistantWaitState`, branch navigation, usage, abort/error, and streaming behavior.

- [ ] **Step 5: Run focused verification**

Run: `pnpm vitest run test/unit/client-ui-models.test.ts test/unit/client-sync-store.test.ts test/unit/llm-messages.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/components/provider-avatar.vue src/client/components/model-picker.vue src/client/components/message-list.vue src/client/components/message-item.vue src/client/views/chat.vue src/client/ui/message src/client/ui/bubble
git commit -m "feat(chat): redesign model and message surfaces"
```

---

### Task 6: Composer and Responsive Secondary Overlays

**Files:**
- Create: `src/client/components/layout/responsive-overlay.vue`
- Modify: `src/client/components/composer.vue`
- Modify: `src/client/components/session-settings.vue`
- Modify: `src/client/components/reasoning-control.vue`
- Modify: `src/client/components/reasoning-controls.vue`
- Modify: `src/client/views/project-settings.vue`

**Interfaces:**
- `ResponsiveOverlay` uses `v-model:open`, `title`, default/footer slots, and `mode`. Side mode renders Sheet at `md` and above and Drawer below; Dialog mode renders one Dialog with a full-screen mobile layout. Preserve opener focus and bottom safe areas.
- Existing Composer emits remain `send(parts)` and `stop()`; exposed `confirmSend()` and `restoreSend()` remain unchanged.
- Existing reasoning choice/store interfaces remain unchanged.

- [ ] **Step 1: Read exact overlay and form docs**

Run:

```powershell
pnpm dlx shadcn-vue@latest docs sheet drawer field input-group attachment slider switch button tooltip
```

Confirm controlled open props/events for the installed Reka base before implementing `ResponsiveOverlay`.

- [ ] **Step 2: Implement the responsive overlay host**

Use `window.matchMedia('(min-width: 768px)')` through VueUse `useMediaQuery`. Desktop content is `SheetContent side="right"`; mobile content is bottom `DrawerContent`. Both branches include their required Title and a scroll-constrained content area.

- [ ] **Step 3: Polish Composer without changing send behavior**

Keep one `InputGroup` card containing attachments, textarea, and tool row. Left controls: image attachment and future-safe slot. Right controls: reasoning chip and round send/stop. Use `aria-disabled` only where the explanatory Tooltip must remain reachable; otherwise use native `disabled`.

Retain upload concurrency, object URL cleanup, paste/drop, optimistic clear, rejected-send restore, max `40vh`, and mobile 16px textarea font.

- [ ] **Step 4: Move secondary forms into responsive overlays**

Session settings uses side-mode `ResponsiveOverlay`; Project editing uses its Dialog mode. Both compose `FieldGroup`/`Field`. Reasoning uses one controlled Popover/Drawer selected by viewport; a breakpoint change closes it and restores its trigger without changing the choice. The existing state/slider semantics and Composer trigger remain.

- [ ] **Step 5: Run focused verification**

Run: `pnpm vitest run test/unit/client-sync-store.test.ts test/unit/client-image-prep.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/components/layout/responsive-overlay.vue src/client/components/composer.vue src/client/components/session-settings.vue src/client/components/reasoning-control.vue src/client/components/reasoning-controls.vue src/client/views/project-settings.vue
git commit -m "feat(chat): unify responsive composer controls"
```

---

### Task 7: Three-Pane Settings and Provider Model Editing

**Files:**
- Create: `src/client/components/layout/settings-sidebar-content.vue`
- Create: `src/client/components/provider-navigation.vue`
- Create: `src/client/components/model-editor.vue`
- Create: `src/client/views/settings-index.vue`
- Create: `src/client/pages/settings/index.vue`
- Modify: `src/client/views/settings-providers.vue`
- Modify: `src/client/views/settings-provider-edit.vue`
- Modify: `src/client/pages/settings/providers/index.vue`
- Modify: `src/client/pages/settings/providers/[id].vue`
- Modify: `src/client/components/layout/app-sidebar.vue`

**Interfaces:**
- `SettingsSidebarContent` renders model services, plugins, and appearance plus “返回聊天”.
- `ProviderNavigation` accepts `selectedProviderId?: number | null` and emits/navigates only through existing provider routes.
- `ModelEditor` accepts `{ open: boolean; providerId: number; model: Model; saving?: boolean }`, owns its draft above the responsive branches, and emits `update:open`, `save(patch)` and `delete()`. It contains no protocol override field.
- Provider detail retains every existing API call and write-serialization guarantee from `settings-provider-edit.vue`.

- [ ] **Step 1: Rebuild desktop settings workspace**

On settings routes, `AppSidebar` renders first-level settings navigation. Provider routes render a fixed-width `ProviderNavigation` beside the route detail inside `SidebarInset`, producing the approved three-pane layout. “返回聊天” retains the chat/Project route that entered settings across internal settings navigation, with `/chats` as the initial fallback.

- [ ] **Step 2: Rebuild mobile settings routes**

`/settings` lists the three settings categories. `/settings/providers` lists searchable providers. `/settings/providers/:id` is a full provider detail page with a back link to the provider list. All retain `MobileBottomNav`.

- [ ] **Step 3: Recompose provider forms**

Use `FieldGroup`, `Field`, `Input`, `Select`, `Switch`, `ButtonGroup`, `Item`, `Badge`, and `Separator`. Preserve protocol-dependent Vertex fields, API-key blank-means-unchanged behavior, `native_files`, enabled state, fetch-model availability, and serialized optimistic model updates.

Use Sonner for save/fetch/add failures and successes. Use `AlertDialog` for provider/model deletion.

- [ ] **Step 4: Add responsive model editing**

The model row gear opens `ModelEditor`, which owns the draft and Task 6’s responsive host: right Sheet on desktop and bottom Drawer on mobile. Fields cover id, display name, enabled, existing capability flags, and reasoning efforts. Do not render multi-endpoint, per-model protocol, or model-purpose controls.

- [ ] **Step 5: Run focused verification**

Run: `pnpm vitest run test/unit/client-ui-models.test.ts test/unit/shared-models.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client/components/layout/settings-sidebar-content.vue src/client/components/provider-navigation.vue src/client/components/model-editor.vue src/client/views/settings-index.vue src/client/views/settings-providers.vue src/client/views/settings-provider-edit.vue src/client/pages/settings/index.vue src/client/pages/settings/providers src/client/components/layout/app-sidebar.vue
git commit -m "feat(settings): rebuild provider management"
```

---

### Task 8: Project, Plugin, Appearance, and Unified Feedback Pages

**Files:**
- Create: `src/client/views/settings-appearance.vue`
- Create: `src/client/pages/settings/appearance.vue`
- Modify: `src/client/views/project-settings.vue`
- Modify: `src/client/views/settings-plugins.vue`
- Modify: `src/client/pages/settings/plugins.vue`
- Modify: `src/client/pages/project/[projectId]/settings.vue`
- Modify: `src/client/components/layout/settings-sidebar-content.vue`
- Modify: `src/client/app.vue`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `useTheme()` from Task 1.
- Appearance page writes only the local theme preference.
- Project/plugin mutations continue to use existing API/WS interfaces.

- [ ] **Step 1: Build the appearance page**

Use a three-item `ToggleGroup` for 跟随系统 / 浅色 / 深色 and Card previews using semantic tokens. Selection calls `setPreference`; the resolved theme updates immediately.

If `vue-sonner` and the shadcn Sonner host are not installed, inspect them with `pnpm dlx shadcn-vue@latest docs sonner` and add them with `pnpm dlx shadcn-vue@latest add sonner`; review every added file before continuing.

- [ ] **Step 2: Recompose Project settings**

Use the same FieldGroup, model picker, numeric fields, inheritance badges, reasoning controls, save feedback, and AlertDialog conventions as session/provider settings inside a desktop Dialog/mobile full-screen Dialog. Close/save returns to `/project/:projectId`; dirty dismissal requires confirmation. Keep the existing `projectUpdateCommand` and deletion semantics.

- [ ] **Step 3: Recompose plugin settings**

Use `ItemGroup` rows with Switch and Badge. Empty plugin state uses `Empty`; load failure uses `Alert`; mutations use Sonner. Do not add plugin capabilities or connection management.

- [ ] **Step 4: Normalize loading, empty, and error states**

Across navigation, Projects, chat, providers, models, and plugins:

- initial unknown/loading collection → `Skeleton` rows;
- loaded empty collection/search result → `Empty` with one relevant action;
- recoverable mutation result → Sonner toast;
- route-blocking load failure → `Alert` in the content region;
- destructive action → `AlertDialog`.

- [ ] **Step 5: Run focused verification**

Run: `pnpm vitest run test/unit/client-theme.test.ts test/unit/client-ui-models.test.ts test/unit/client-sync-store.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/client/ui/sonner src/client/views/settings-appearance.vue src/client/pages/settings/appearance.vue src/client/views/project-settings.vue src/client/views/settings-plugins.vue src/client/pages/settings/plugins.vue src/client/pages/project src/client/components/layout/settings-sidebar-content.vue src/client/app.vue
git commit -m "feat(settings): unify remaining settings pages"
```

---

### Task 9: Browser QA, Cleanup, and Final Verification

**Files:**
- Modify: UI files found defective during the checks above.
- Modify: `README.md` only if its navigation/setup description contradicts the finished UI.
- Review only: `src/client/typed-router.d.ts`, `test/unit/__snapshots__/llm-messages.test.ts.snap` before deciding whether regenerated changes belong to this branch.

**Interfaces:**
- Produces no new public interface; this task closes visual, accessibility, and regression gaps.

- [ ] **Step 1: Start or reuse the local dev server safely**

Check the requested port first. If it is occupied by a process not started during this execution, do not stop it; either reuse the matching only-chat server or ask before terminating it. Do not use a preview deployment because it shares production bindings.

- [ ] **Step 2: Verify the desktop matrix in a real browser**

At a viewport at least 1280px wide, verify:

- outer Project-first sidebar with exactly five recent Projects and 查看全部;
- 随心聊 below Projects;
- Project sidebar replacement and scoped search;
- full model Popover search/filter/grouping;
- Project assistant identity and secondary actual model;
- Composer reasoning as the only reasoning trigger;
- settings three-pane layout;
- inline provider detail, model editor in a right Sheet, and Project settings in a centered Dialog;
- empty/loading/error/delete states;
- every fixed-height region owns its intended scrollbar.

- [ ] **Step 3: Verify the mobile matrix in a real browser**

At a viewport around 390×844, verify:

- `[聊天][＋][设置]` on functional pages;
- center `＋` always opens a no-Project draft;
- Project-specific new-chat action opens `/project/:projectId/new`;
- concrete chat hides bottom nav and shows Composer;
- Project name in mobile header, icon-only model trigger, accessible full model name;
- settings three-level navigation;
- model/session edits open bottom Drawers; Project settings opens a full-screen Dialog;
- keyboard, safe-area, 16px textarea, and 40px touch targets.

- [ ] **Step 4: Verify all theme modes**

Check light, dark, and system. Reload each explicit mode and system mode; confirm no light flash, persisted choice, correct `color-scheme`, readable semantic status colors, and no page-level raw color that breaks dark mode.

- [ ] **Step 5: Run final automated checks**

Run targeted tests first:

```bash
pnpm vitest run test/unit/client-theme.test.ts test/unit/client-ui-models.test.ts test/unit/client-sync-store.test.ts test/unit/client-image-prep.test.ts
pnpm typecheck
pnpm build
```

Before the authorized branch push, run the full suite once:

```bash
pnpm test
```

Expected: all commands exit 0.

- [ ] **Step 6: Review generated and unrelated diffs**

Run:

```bash
git status --short
git diff -- src/client/typed-router.d.ts test/unit/__snapshots__/llm-messages.test.ts.snap
git diff --check
```

Stage `typed-router.d.ts` only if the new routes legitimately changed its generated declarations. Stage the LLM message snapshot only if a relevant test intentionally changed rendered/serialized output; otherwise leave the pre-existing worktree marker untouched.

- [ ] **Step 7: Update stale documentation if necessary**

If README UI paths or interaction wording no longer match the finished app, update only those exact sections and mention that `docs/superpowers/specs/2026-09-06-unified-ui-redesign.md` supersedes prior UI layout decisions.

- [ ] **Step 8: Commit the QA fixes**

```bash
git add -u -- src/client README.md ':(exclude)src/client/typed-router.d.ts'
git commit -m "fix(ui): close responsive design gaps"
```

If Step 2–7 produce no tracked changes, skip this commit.

- [ ] **Step 9: Push the completed implementation branch**

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:HTTP_PROXY=$env:HTTPS_PROXY
git push
```
