# Persistent Sidebar Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Only Chat branding, WebSocket status, settings, and a placeholder account visible in every desktop/sidebar context, and enlarge row action hit targets.

**Architecture:** `AppSidebar` owns a permanent header and footer around route-specific sidebar content. Small focused components render branding/status and the placeholder account; chat, Project, and settings components render only contextual navigation. Existing shadcn-vue Sidebar primitives remain the layout source of truth.

**Tech Stack:** Vue 3, Pinia, vue-router, shadcn-vue Sidebar, Tailwind CSS, Vitest, happy-dom.

**Spec:** `docs/superpowers/specs/2026-09-07-provider-catalog-and-interface-design.md`

## Global Constraints

- Branding text is exactly `Only Chat`.
- WebSocket states are green for `open`, yellow for `connecting`, and red for `closed`.
- The footer is visible in chat, Project, and settings contexts.
- Desktop row action targets are 32×32; mobile targets are at least 40×40; icons remain 16px.
- Use existing shadcn-vue Sidebar primitives and semantic color tokens.
- Do not change routes, server APIs, or chat data behavior in this plan.

---

### Task 1: Persistent sidebar frame

**Files:**
- Create: `src/client/components/layout/sidebar-brand.vue`
- Create: `src/client/components/layout/sidebar-account-placeholder.vue`
- Create: `src/client/components/layout/sidebar-global-footer.vue`
- Modify: `src/client/components/layout/app-sidebar.vue`
- Modify: `src/client/components/layout/chat-sidebar-content.vue`
- Test: `test/unit/client-sidebar-collapse.test.ts`
- Test: `test/unit/client-app-sidebar.test.ts`

**Interfaces:**
- Consumes: `useSyncStore().status: 'connecting' | 'open' | 'closed'` and `useRoute().path`.
- Produces: `SidebarBrand` with prop `status: WsStatus`; `SidebarGlobalFooter` with active settings state derived from the route; route-specific content without a footer.

- [ ] **Step 1: Write failing frame tests**

Add `test/unit/client-app-sidebar.test.ts` cases that mount `AppSidebar` with Pinia and a memory router for `/new`, `/project/1`, and `/settings/providers`. Assert each rendering contains `Only Chat`, a settings link, `Only Chat User`, and a status element with `data-status="open"`. Extend the collapse test to assert the status element remains rendered when the provider state is `collapsed`.

```ts
expect(wrapper.get('[data-sidebar-brand]').text()).toContain('Only Chat')
expect(wrapper.get('[data-connection-status]').attributes('data-status')).toBe('open')
expect(wrapper.get('a[href="/settings/providers"]').exists()).toBe(true)
expect(wrapper.text()).toContain('Only Chat User')
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm vitest run test/unit/client-app-sidebar.test.ts test/unit/client-sidebar-collapse.test.ts`

Expected: FAIL because the global brand/footer components do not exist and settings context does not render them.

- [ ] **Step 3: Implement the permanent frame**

Create `SidebarBrand` using `SidebarHeader`, `SidebarMenu`, and `SidebarMenuButton`. Render the status dot beside the label and as an absolute badge on the icon in collapsed state. Give the dot a focusable tooltip/accessible label such as `服务器已连接`.

```ts
const statusLabel = computed(() => ({
  open: '服务器已连接',
  connecting: '正在连接服务器',
  closed: '服务器连接已断开，正在重试',
}[props.status]))
```

Create `SidebarGlobalFooter` using `SidebarFooter`; render the settings row and `SidebarAccountPlaceholder`. The placeholder is inert and displays `Only Chat User / 本地账户`.

Move the ordinary chat branding and existing settings footer out of `chat-sidebar-content.vue`. Compose the sidebar in this order:

```vue
<SidebarBrand :status="sync.status" />
<SettingsSidebarContent v-if="isSettings" />
<ChatSidebarContent v-else :project-id="projectId" />
<SidebarGlobalFooter />
<SidebarRail />
```

- [ ] **Step 4: Run the focused tests and verify pass**

Run: `pnpm vitest run test/unit/client-app-sidebar.test.ts test/unit/client-sidebar-collapse.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the frame**

```bash
git add src/client/components/layout/sidebar-brand.vue src/client/components/layout/sidebar-account-placeholder.vue src/client/components/layout/sidebar-global-footer.vue src/client/components/layout/app-sidebar.vue src/client/components/layout/chat-sidebar-content.vue test/unit/client-app-sidebar.test.ts test/unit/client-sidebar-collapse.test.ts
git commit -m "fix(sidebar): retain global navigation chrome"
```

### Task 2: Route-specific content and active states

**Files:**
- Modify: `src/client/components/layout/settings-sidebar-content.vue`
- Modify: `src/client/components/layout/chat-sidebar-content.vue`
- Modify: `src/client/components/layout/sidebar-global-footer.vue`
- Test: `test/unit/client-app-sidebar.test.ts`

**Interfaces:**
- Consumes: the persistent frame from Task 1.
- Produces: route-specific header/content with no duplicated brand or footer; settings active state for every `/settings/*` route.

- [ ] **Step 1: Add failing context tests**

Assert Project mode contains the Project switcher and back action exactly once beneath the global brand. Assert settings mode contains its category navigation, has one settings footer link marked active, and has no duplicate “设置” navigation row inside the content.

```ts
expect(wrapper.findAll('[data-sidebar-brand]')).toHaveLength(1)
expect(wrapper.findAll('[data-global-settings]')).toHaveLength(1)
expect(wrapper.get('[data-global-settings]').attributes('data-active')).toBe('true')
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm vitest run test/unit/client-app-sidebar.test.ts`

Expected: FAIL until active/context ownership is explicit.

- [ ] **Step 3: Normalize content ownership**

Keep Project back/switch/new/search/settings controls in the route-specific content. Keep settings back/category controls in `settings-sidebar-content.vue`. Add stable data attributes used by tests and derive the footer active state from `route.path.startsWith('/settings')`.

- [ ] **Step 4: Run the test and verify pass**

Run: `pnpm vitest run test/unit/client-app-sidebar.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit contextual navigation**

```bash
git add src/client/components/layout/settings-sidebar-content.vue src/client/components/layout/chat-sidebar-content.vue src/client/components/layout/sidebar-global-footer.vue test/unit/client-app-sidebar.test.ts
git commit -m "fix(sidebar): separate global and contextual navigation"
```

### Task 3: Row action hit targets and visual verification

**Files:**
- Modify: `src/client/components/layout/session-nav-row.vue`
- Modify: `src/client/components/layout/project-nav-row.vue`
- Test: `test/unit/client-sidebar-rows.test.ts`

**Interfaces:**
- Consumes: existing `SidebarMenuAction(show-on-hover)` dropdown triggers.
- Produces: stable `data-row-action` targets sized 32px desktop and 40px mobile, with 16px icons and non-overlapping labels.

- [ ] **Step 1: Add failing hit-target tests**

Mount both row components in desktop and mocked mobile sidebar contexts. Assert the trigger includes explicit size classes and the icon keeps `size-4`.

```ts
expect(action.classes()).toContain('size-8')
expect(action.classes()).toContain('max-md:size-10')
expect(action.get('svg').classes()).toContain('size-4')
```

- [ ] **Step 2: Run the row test and verify failure**

Run: `pnpm vitest run test/unit/client-sidebar-rows.test.ts`

Expected: FAIL because the action uses the smaller primitive default.

- [ ] **Step 3: Implement target sizing**

Add `data-row-action`, `size-8 max-md:size-10`, and ` [&>svg]:size-4` to both `SidebarMenuAction` triggers. Add enough right padding to the associated `SidebarMenuButton` so long labels never sit beneath the trigger. Preserve `show-on-hover`, keyboard focus, and the existing dropdown/alert behavior.

- [ ] **Step 4: Run sidebar tests**

Run: `pnpm vitest run test/unit/client-sidebar-rows.test.ts test/unit/client-sidebar-collapse.test.ts test/unit/client-app-sidebar.test.ts`

Expected: PASS.

- [ ] **Step 5: Run typecheck and browser QA**

Run: `pnpm typecheck`

Expected: PASS.

Use the existing local dev server or start one only on an available port. Verify `/new`, `/project/:id`, and `/settings/providers` at desktop width, then collapse the sidebar and verify the status badge. Verify the mobile Sheet keeps 40px action targets. Do not stop a server owned by another process.

- [ ] **Step 6: Commit hit targets**

```bash
git add src/client/components/layout/session-nav-row.vue src/client/components/layout/project-nav-row.vue test/unit/client-sidebar-rows.test.ts
git commit -m "fix(sidebar): enlarge row action targets"
```
