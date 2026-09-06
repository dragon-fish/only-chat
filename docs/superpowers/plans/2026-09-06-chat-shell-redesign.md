# Chat Shell Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the chat page's shell — a page-owned top bar, a single-card Composer, and a reasoning control whose three non-strength states each get their own single-purpose widget.

**Architecture:** `app-shell.vue` keeps one header row but stops owning its content: it renders the mobile drawer button plus a Teleport target, and each route teleports its own title and actions in. A route component cannot fill a named slot of its layout, because the layout renders it through the default `<slot />` — Teleport is what makes a shell-owned bar with route-owned content possible. The Composer becomes one bordered card holding the textarea and a toolbar row. The reasoning control splits `reasoningStopsFor`'s single list across a 思考 switch, an 自动 toggle, and a strength-only slider, driven by one new pure function that the unit project can test.

**Tech Stack:** Vue 3 (`<script setup>`, Pug SFC templates), Reka UI, Tailwind v4, Pinia, Vite, Vitest, `@lucide/vue`.

**Spec:** `docs/superpowers/specs/2026-09-06-chat-shell-redesign.md`

## Global Constraints

- Copy the references; do not invent. Cherry Studio 2.0 supplies the top-bar chips, the single-card Composer and the reasoning popover's structure; Codex supplies the slider itself.
- The top bar is a **normal, always-present bar**. Do not implement a transparent-then-materialising bar, and do not add scroll observers for it.
- The strength slider is a **monotonic strength axis**. `关闭` and `自动` are never stops on it.
- Every stop must be readable as a name. The user must always be able to tell which stop is selected; position alone is not enough.
- The strength slider is used on **both** breakpoints. Do not degrade it to a list on mobile.
- Never infer any capability from a model id. `reasoningStopsFor(capabilities, protocol)` stays the single source of truth for what the controls offer, and its semantics do not change.
- Controls that cannot act must be **disabled with a stated reason**, never silently hidden.
- Storage keys are unchanged: `choiceToParams` already maps 继承 → `{}`, 关闭 → `{ reasoning_enabled: false }`, 自动 → `{ reasoning_enabled: true, reasoning_effort: null }`, 强度 X → `{ reasoning_enabled: true, reasoning_effort: X }`.
- Every fixed-height region keeps exactly one vertical scroll owner. The top bar and the Composer never scroll.
- **Pug templates:** any Tailwind class containing `/`, `[`, `]`, `:` or `.` must go inside a string `class="…"` attribute, never in `.class` dot-shorthand position. `(` must be flush against its tag token. No TypeScript in template expressions. `//-` for comments; `//` renders. An intervening node breaks `v-if`/`v-else` adjacency.
- **Components cannot be unit-tested in this repo.** The `unit` vitest project is node-env with no Vue plugin, no jsdom and no `@vue/test-utils`. `pnpm typecheck` and `pnpm build` prove only that templates compile — this branch has already shipped a TDZ `ReferenceError` and a `tbody`-inside-`thead` past both gates. Put risk-bearing logic in exported pure functions and test those.
- **Verify in a local dev server, in a real browser.** Do not push a branch for a preview deployment: previews share `wrangler.jsonc`'s bindings with production (same D1, same R2), and `preview_urls` is `false` anyway.
- Run focused tests while working. Run `pnpm test` once at the end of the last task.

## File Structure

- `src/client/components/app-shell.vue` — owns one header row: the mobile drawer button and a Teleport target. No longer renders the app name or connection status.
- `src/client/components/session-list.vue` — sidebar header gains the app name and connection dot.
- `src/client/views/settings-providers.vue`, `settings-plugins.vue`, `settings-provider-edit.vue`, `project-settings.vue` — each teleports its page title into the bar; the `h1`/back-link that duplicated it is removed from the scrolling body.
- `src/client/views/chat.vue` — teleports the chat's own bar (project label, model chip, session settings) and stops passing those controls to the Composer.
- `src/client/components/composer.vue` — one bordered card; toolbar row hosts the attachment button, a `controls` slot and the send button.
- `src/client/components/reasoning-control.vue` — **new.** The chip plus its popover: 思考 switch, 自动 toggle, strength slider. Replaces `reasoning-slider.vue`.
- `src/client/components/reasoning-slider.vue` — **deleted** at the end of Task 5.
- `src/client/stores/sync.ts` — gains `reasoningControlModel` and `reasoningChoiceFor`, the pure functions the new component is driven by.
- `test/unit/client-sync-store.test.ts` — covers both new pure functions.

---

### Task 1: Move the shell header's content out of the shell

**Files:**
- Modify: `src/client/components/app-shell.vue`
- Modify: `src/client/components/session-list.vue`
- Modify: `src/client/views/settings-providers.vue`
- Modify: `src/client/views/settings-plugins.vue`
- Modify: `src/client/views/settings-provider-edit.vue`
- Modify: `src/client/views/project-settings.vue`

**Interfaces:**
- Produces: a Teleport target with `id="page-header"`, present on every route, that later tasks and any future route fill.
- Consumes: nothing.

- [ ] **Step 1: Turn the shell header into a drawer button plus a Teleport target**

In `src/client/components/app-shell.vue`, replace the `header` element with:

```pug
  header.flex.h-12.shrink-0.items-center.gap-2.border-b.px-3
    Button(variant="ghost" size="icon" class="md:hidden" @click="drawerOpen = true")
      Menu(class="size-5")
    #page-header.flex.min-w-0.flex-1.items-center.gap-2
```

The `only-chat` span and the connection dot are deleted from this file. Leave the two error banner rows and the route region below it untouched.

- [ ] **Step 2: Give the app name and connection status a home in the sidebar**

In `src/client/components/session-list.vue`, add a row **above** the existing 新对话 row, inside the same `.flex.h-full.min-h-0.flex-col.overflow-hidden` root:

```pug
  .flex.shrink-0.items-center.gap-2.px-4.pt-3
    span.text-sm.font-semibold only-chat
    span.ml-auto.size-2.rounded-full(:class="sync.status === 'open' ? 'bg-emerald-500' : 'bg-zinc-400'" :title="sync.status")
```

Add the store import and instance to that file's `<script setup>`:

```ts
import { useSyncStore } from '@/client/stores/sync'

const sync = useSyncStore()
```

- [ ] **Step 3: Teleport each settings page's title into the bar**

In `src/client/views/settings-providers.vue`, delete the `h1.text-lg.font-semibold 供应商` line from the scrolling body and add this as the **first child** of the route root (`.h-full.min-h-0.overflow-hidden`):

```pug
  Teleport(to="#page-header")
    span.truncate.text-sm.font-medium 供应商
```

In `src/client/views/settings-plugins.vue`, delete both the `RouterLink` back-link and the `h1.text-lg.font-semibold 插件` line from the body, and add as the first child of the route root:

```pug
  Teleport(to="#page-header")
    RouterLink.shrink-0.text-muted-foreground(to="/settings/providers" class="hover:text-foreground") ←
    span.truncate.text-sm.font-medium 插件
```

In `src/client/views/settings-provider-edit.vue`, delete both the `RouterLink` back-link and the `h1.text-lg.font-semibold 编辑供应商` line from the body, and add as the first child of the route root:

```pug
  Teleport(to="#page-header")
    RouterLink.shrink-0.text-muted-foreground(to="/settings/providers" class="hover:text-foreground") ←
    span.truncate.text-sm.font-medium 编辑供应商
```

In `src/client/views/project-settings.vue`, delete the `RouterLink.mb-2.text-xs.text-muted-foreground(to="/") ← 返回` line from the left nav and add as the first child of the route root (`.flex.h-full.min-h-0.overflow-hidden`):

```pug
  Teleport(to="#page-header")
    RouterLink.shrink-0.text-muted-foreground(to="/" class="hover:text-foreground") ←
    span.truncate.text-sm.font-medium {{ project?.name ?? '项目设置' }}
```

Import `Teleport` is not required — it is a Vue built-in. `RouterLink` is already imported in every file that uses it; leave those imports in place.

- [ ] **Step 4: Verify it compiles and the emitted markup is what you intended**

Run:

```powershell
pnpm typecheck
pnpm build
```

Expected: both exit 0.

Then confirm the Pug actually produced a Teleport rather than an element with an id, by compiling one changed template and reading the render function:

```powershell
node -e "const fs=require('fs');const {parse,compileTemplate}=require('@vue/compiler-sfc');const d=parse(fs.readFileSync('src/client/views/settings-plugins.vue','utf8')).descriptor;const r=compileTemplate({source:d.template.content,filename:'x.vue',id:'x',preprocessLang:'pug'});console.log(r.errors);console.log(r.code.includes('Teleport')?'TELEPORT OK':'NO TELEPORT')"
```

Expected: an empty error array and `TELEPORT OK`.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/app-shell.vue src/client/components/session-list.vue src/client/views/settings-providers.vue src/client/views/settings-plugins.vue src/client/views/settings-provider-edit.vue src/client/views/project-settings.vue
git commit -m "refactor(ui): let each route own the top bar's content"
```

---

### Task 2: Give the chat page its own top bar

**Files:**
- Modify: `src/client/views/chat.vue`

**Interfaces:**
- Consumes: the `#page-header` Teleport target from Task 1.
- Produces: a chat page whose Composer receives only the reasoning control through its `controls` slot. `ModelPicker` and `SessionSettings` no longer appear inside the Composer.

- [ ] **Step 1: Teleport the chat bar's content**

In `src/client/views/chat.vue`, add this as the **first child** of the root `.flex.h-full.flex-col`:

```pug
  Teleport(to="#page-header")
    span.shrink-0.truncate.text-sm.text-muted-foreground(v-if="project") {{ project.name }}
    span.shrink-0.text-muted-foreground(v-if="project") ›
    ModelPicker(:model-value="effective.model" @update:model-value="onModelChange")
    button.shrink-0.text-muted-foreground(
      v-if="sources.model === 'session'" type="button" title="恢复继承"
      class="hover:text-foreground" @click="setOverride(null)")
      RotateCcw(class="size-3.5")
    .ml-auto.shrink-0
      SessionSettings(
        :form="form" :sources="sources" :project="project" :has-session="sid !== null"
        @commit="commitSettings")
```

The project name is a **read-only label**, not a link: navigating from it into project settings belongs to a later round.

- [ ] **Step 2: Strip the moved controls out of the Composer slot**

Still in `src/client/views/chat.vue`, replace the whole `template(#controls)` block with only the reasoning control it will keep:

```pug
    template(#controls)
      ReasoningSlider(
        class="w-56" :model-value="form.reasoning" :stops="stops" :model-name="modelName"
        :inherited="inheritedReasoning" :source-label="SOURCE_LABELS[sources.reasoning]"
        :can-reset="form.reasoning !== 'inherit'" @update:model-value="onReasoningChange")
```

`ReasoningSlider` is replaced wholesale in Task 5; leave it as-is here so this task stays independently reviewable.

- [ ] **Step 3: Verify**

Run:

```powershell
pnpm typecheck
pnpm build
```

Expected: both exit 0. `SOURCE_LABELS[sources.model]` is no longer rendered anywhere; if `SOURCE_LABELS` becomes unused, leave it — Task 5 still reads it.

- [ ] **Step 4: Look at it**

Start a dev server on a free port and open it in a browser:

```powershell
pnpm exec vite dev --port 5199 --strictPort
```

Confirm by eye: the top bar shows the model chip (and a project name when the chat is in a Project); the Composer's bottom row no longer contains the model picker or the 会话设置 button. **A dev server may already be running on 5173 — do not stop it.** Stop only the server you started.

- [ ] **Step 5: Commit**

```bash
git add src/client/views/chat.vue
git commit -m "feat(chat): move the model chip and session settings into the top bar"
```

---

### Task 3: Make the Composer one card

**Files:**
- Modify: `src/client/components/composer.vue`

**Interfaces:**
- Consumes: the `controls` slot contract, unchanged.
- Produces: a Composer whose root is a single bordered card; `busy`, `hint` and connection messaging keep their current behaviour.

- [ ] **Step 1: Rebuild the template as one card**

In `src/client/components/composer.vue`, replace the whole `<template>` with:

```pug
<template lang="pug">
.p-3(@drop="onDrop" @dragover.prevent)
  .mx-auto.flex.max-w-3xl.flex-col.gap-2.rounded-xl.border.p-2(class="bg-background focus-within:border-ring")
    .flex.flex-wrap.gap-2(v-if="images.length")
      .relative(v-for="(img, i) in images" :key="i")
        img.h-16.w-16.rounded.object-cover(v-if="!img.failed" :src="img.preview")
        .h-16.w-16.rounded.bg-destructive.text-xs.text-white.flex.items-center.justify-center(v-else) 失败
        button.absolute.rounded-full.bg-background.border(class="-right-1 -top-1" @click="removeImage(i)")
          X(class="size-3")
    textarea.w-full.resize-none.bg-transparent.px-1.text-sm(
      v-model="text" rows="2" placeholder="输入消息…"
      class="oc-scroll max-h-[40vh] outline-none placeholder:text-muted-foreground"
      @keydown="onKeydown" @paste="onPaste" @input="autoGrow")
    //- Spec §7.3: the bottom row wraps on a narrow screen and nothing here needs hover to operate.
    .flex.flex-wrap.items-center.gap-1
      input.hidden(ref="fileInput" type="file" accept="image/*" multiple @change="onFileChange")
      button.rounded-md.text-muted-foreground(
        type="button" title="添加图片" :disabled="busy"
        class="inline-flex size-8 items-center justify-center hover:bg-accent hover:text-foreground disabled:opacity-50"
        @click="fileInput?.click()")
        ImagePlus(class="size-4")
      slot(name="controls")
      .ml-auto.flex.items-center.gap-2
        span.text-xs.text-muted-foreground(v-if="busy") 上传中…
        span.text-xs.text-muted-foreground(v-if="!connected") 未连接
        span.text-xs(v-else-if="hint" class="text-destructive") {{ hint }}
        button.rounded-full.bg-destructive.text-white(
          v-if="streaming" type="button" title="停止"
          class="inline-flex size-9 items-center justify-center" @click="emit('stop')")
          Square(class="size-4")
        button.rounded-full.bg-primary(
          v-else type="button" title="发送" :disabled="!connected || !canSend || busy"
          class="inline-flex size-9 items-center justify-center text-primary-foreground disabled:opacity-40"
          @click="submit")
          Send(class="size-4")
</template>
```

The outer `border-t` is gone: the card's own border now separates the Composer from the message list.

- [ ] **Step 2: Make the textarea grow with its content**

In the same file's `<script setup>`, add after `const fileInput = ...`:

```ts
const box = ref<HTMLTextAreaElement | null>(null)

/** The card grows with the message until the textarea hits its own max height and scrolls. */
function autoGrow() {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
```

Bind that ref by adding `ref="box"` to the `textarea` in the template you just wrote.

Reset the height when the box is cleared, inside `submit()`, immediately after `images.value = []`:

```ts
  if (box.value) box.value.style.height = 'auto'
```

`restoreSend()` puts text back into an already-shrunk box, so add `autoGrow()` as its last line too.

Remove the now-unused `Textarea` and `Button` imports from this file. Keep `ImagePlus`, `Send`, `Square` and `X`.

- [ ] **Step 3: Verify**

Run:

```powershell
pnpm typecheck
pnpm build
pnpm exec vitest run --project unit test/unit/client-sync-store.test.ts
```

Expected: typecheck and build exit 0; the unit test file still passes untouched.

- [ ] **Step 4: Look at it**

On a dev server you started, confirm by eye: the textarea and the toolbar sit inside one rounded border; the send button is a circle; typing several lines grows the card until it stops and the textarea scrolls internally; attaching an image still shows its thumbnail inside the card.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/composer.vue
git commit -m "feat(chat): collapse the composer into a single card"
```

---

### Task 4: Derive the three reasoning controls from one pure function

**Files:**
- Modify: `src/client/stores/sync.ts`
- Test: `test/unit/client-sync-store.test.ts`

**Interfaces:**
- Consumes: `reasoningStopsFor(capabilities, protocol)` and `ReasoningChoice`, both unchanged.
- Produces:
  - `interface ReasoningControlModel { canDisable: boolean; enabled: boolean; auto: boolean; strengths: ReasoningStop[]; index: number; unsupported: boolean }`
  - `reasoningControlModel(stops: ReasoningStop[], active: ReasoningChoice): ReasoningControlModel`
  - `reasoningChoiceFor(model: ReasoningControlModel, action: ReasoningAction): ReasoningChoice`
  - `type ReasoningAction = { kind: 'enable'; on: boolean } | { kind: 'auto'; on: boolean } | { kind: 'strength'; stop: ReasoningStop }`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/client-sync-store.test.ts`:

```ts
describe('reasoningControlModel', () => {
  const FULL: ReasoningStop[] = ['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

  it('keeps off and auto off the strength axis', () => {
    const m = reasoningControlModel(FULL, 'medium')
    expect(m.strengths).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(m.index).toBe(2)
    expect(m.enabled).toBe(true)
    expect(m.auto).toBe(false)
  })

  it('reports auto as enabled with no selected strength', () => {
    const m = reasoningControlModel(FULL, 'auto')
    expect(m.auto).toBe(true)
    expect(m.enabled).toBe(true)
    expect(m.index).toBe(-1)
  })

  it('treats a fully unset value as auto, because nothing is pinned anywhere', () => {
    expect(reasoningControlModel(FULL, 'inherit').auto).toBe(true)
  })

  it('reports off', () => {
    const m = reasoningControlModel(FULL, 'off')
    expect(m.enabled).toBe(false)
    expect(m.auto).toBe(false)
    expect(m.index).toBe(-1)
  })

  it('only allows disabling when the stops say so', () => {
    expect(reasoningControlModel(FULL, 'auto').canDisable).toBe(true)
    expect(reasoningControlModel(['auto', 'low'], 'auto').canDisable).toBe(false)
  })

  it('flags a stored strength this model does not offer instead of rewriting it', () => {
    const m = reasoningControlModel(['auto', 'low', 'high'], 'ultra')
    expect(m.unsupported).toBe(true)
    expect(m.index).toBe(-1)
    expect(m.enabled).toBe(true)
  })

  it('does not flag auto or off as unsupported', () => {
    expect(reasoningControlModel(['auto', 'low'], 'auto').unsupported).toBe(false)
    expect(reasoningControlModel(['auto', 'low'], 'off').unsupported).toBe(false)
  })
})

describe('reasoningChoiceFor', () => {
  const FULL: ReasoningStop[] = ['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

  it('turning 思考 off writes off', () => {
    const m = reasoningControlModel(FULL, 'high')
    expect(reasoningChoiceFor(m, { kind: 'enable', on: false })).toBe('off')
  })

  it('turning 思考 on lands on auto rather than guessing a strength', () => {
    const m = reasoningControlModel(FULL, 'off')
    expect(reasoningChoiceFor(m, { kind: 'enable', on: true })).toBe('auto')
  })

  it('turning 自动 on releases the pinned strength', () => {
    const m = reasoningControlModel(FULL, 'high')
    expect(reasoningChoiceFor(m, { kind: 'auto', on: true })).toBe('auto')
  })

  it('turning 自动 off lands on the middle strength', () => {
    const m = reasoningControlModel(FULL, 'auto')
    expect(reasoningChoiceFor(m, { kind: 'auto', on: false })).toBe('high')
  })

  it('picking a stop selects it and leaves auto', () => {
    const m = reasoningControlModel(FULL, 'auto')
    expect(reasoningChoiceFor(m, { kind: 'strength', stop: 'low' })).toBe('low')
  })

  it('turning 自動 off with a single strength picks that one', () => {
    const m = reasoningControlModel(['auto', 'low'], 'auto')
    expect(reasoningChoiceFor(m, { kind: 'auto', on: false })).toBe('low')
  })
})
```

Add `reasoningControlModel`, `reasoningChoiceFor` and the types to that file's existing import from `@/client/stores/sync`.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
pnpm exec vitest run --project unit test/unit/client-sync-store.test.ts
```

Expected: FAIL — `reasoningControlModel is not a function`.

- [ ] **Step 3: Implement both functions**

Append to `src/client/stores/sync.ts`, directly below `reasoningStopsFor`:

```ts
/** What the three reasoning widgets show, derived from one stop list (spec §5.5). */
export interface ReasoningControlModel {
  /** Whether the 思考 switch can be turned off at all. */
  canDisable: boolean
  /** Whether reasoning is currently on. */
  enabled: boolean
  /** On means "enabled, with no strength pinned" — the provider decides. */
  auto: boolean
  /** The slider's axis. Never contains `off` or `auto`: neither is a strength. */
  strengths: ReasoningStop[]
  /** Index into `strengths`; -1 whenever no strength is pinned. */
  index: number
  /** A stored strength this model does not offer. Shown as-is, never silently rewritten. */
  unsupported: boolean
}

export type ReasoningAction =
  | { kind: 'enable'; on: boolean }
  | { kind: 'auto'; on: boolean }
  | { kind: 'strength'; stop: ReasoningStop }

/**
 * `active` is the value in force at this layer — the layer's own choice, or what it inherits.
 * `inherit` reaching here means nothing is pinned anywhere, which is the same request as `auto`:
 * reason, but send no effort.
 */
export function reasoningControlModel(stops: ReasoningStop[], active: ReasoningChoice): ReasoningControlModel {
  const strengths = stops.filter((s): s is ReasoningStop => s !== 'off' && s !== 'auto')
  const enabled = active !== 'off'
  const auto = enabled && (active === 'auto' || active === 'inherit')
  const index = auto || !enabled ? -1 : strengths.indexOf(active as ReasoningStop)
  return {
    canDisable: stops.includes('off'),
    enabled,
    auto,
    strengths,
    index,
    unsupported: enabled && !auto && index < 0,
  }
}

/**
 * The choice each widget interaction writes. Leaving 自动 lands on the middle strength: the spec
 * defines entering auto and picking a stop, but not leaving auto by the toggle, and the midpoint
 * is the one answer that does not bias the user toward either end of the axis.
 */
export function reasoningChoiceFor(model: ReasoningControlModel, action: ReasoningAction): ReasoningChoice {
  if (action.kind === 'strength') return action.stop
  if (action.kind === 'enable') return action.on ? 'auto' : 'off'
  if (action.on) return 'auto'
  const middle = model.strengths[Math.floor((model.strengths.length - 1) / 2)]
  return middle ?? 'auto'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```powershell
pnpm exec vitest run --project unit test/unit/client-sync-store.test.ts
pnpm typecheck
```

Expected: PASS, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/client/stores/sync.ts test/unit/client-sync-store.test.ts
git commit -m "feat(chat): derive the reasoning widgets from one pure model"
```

---

### Task 5: Build the reasoning control

**Files:**
- Create: `src/client/components/reasoning-control.vue`
- Delete: `src/client/components/reasoning-slider.vue`
- Modify: `src/client/views/chat.vue`

**Interfaces:**
- Consumes: `reasoningControlModel`, `reasoningChoiceFor`, `ReasoningAction`, `REASONING_LABELS`, `reasoningStopsFor` — all from Task 4 and earlier.
- Produces: `ReasoningControl` with props `modelValue: ReasoningChoice`, `stops: ReasoningStop[]`, `modelName?: string | null`, `inherited?: ReasoningChoice`, `canReset?: boolean`, and the single emit `update:modelValue`.

- [ ] **Step 1: Write the component**

Create `src/client/components/reasoning-control.vue`:

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { Brain, RotateCcw } from '@lucide/vue'
import { Switch } from '@/client/ui/switch'
import {
  REASONING_LABELS, reasoningChoiceFor, reasoningControlModel,
  type ReasoningAction, type ReasoningChoice, type ReasoningStop,
} from '@/client/stores/sync'

const props = withDefaults(defineProps<{
  /** What this layer stores. `inherit` writes nothing and falls through to `inherited`. */
  modelValue: ReasoningChoice
  /** What this model's declared capabilities allow, weakest first (spec §5.5). */
  stops: ReasoningStop[]
  /** Named in the popover so it is always clear whose capabilities produced these stops. */
  modelName?: string | null
  /** What `inherit` resolves to below this layer. */
  inherited?: ReasoningChoice
  /** Whether restoring inheritance is meaningful here. */
  canReset?: boolean
}>(), { modelName: null, inherited: 'inherit', canReset: false })

const emit = defineEmits<{ 'update:modelValue': [ReasoningChoice] }>()

const open = ref(false)
const track = ref<HTMLElement | null>(null)
const dragging = ref(false)

const active = computed<ReasoningChoice>(() => props.modelValue === 'inherit' ? props.inherited : props.modelValue)
const model = computed(() => reasoningControlModel(props.stops, active.value))

/** The chip is a status readout first; it says why it cannot act rather than disappearing. */
const chipLabel = computed(() => {
  if (!props.stops.length) return props.modelName ? '不支持推理' : '未选择模型'
  if (!model.value.enabled) return '不思考'
  if (model.value.auto) return '自动'
  const current = model.value.strengths[model.value.index]
  return current ? REASONING_LABELS[current] : `${labelOfChoice(active.value)}（不适用）`
})
const chipTitle = computed(() => {
  if (props.stops.length) return '思考强度'
  return props.modelName ? '该模型未声明推理能力' : '请先选择模型'
})

function labelOfChoice(choice: ReasoningChoice): string {
  return choice === 'inherit' ? '默认' : REASONING_LABELS[choice]
}
function labelOf(stop: ReasoningStop): string {
  return REASONING_LABELS[stop]
}
function apply(action: ReasoningAction) {
  emit('update:modelValue', reasoningChoiceFor(model.value, action))
}

/** A lone stop sits mid-track: pinning it right would read as a maxed-out level. */
function percent(i: number): string {
  const n = model.value.strengths.length
  return n < 2 ? '50%' : `${(i / (n - 1)) * 100}%`
}
const fill = computed(() => model.value.index < 0 ? '0%' : percent(model.value.index))
const tone = computed(() => {
  const n = model.value.strengths.length
  if (model.value.index === n - 1 && n > 2) return 'bg-gradient-to-r from-blue-500 to-purple-500'
  return 'bg-blue-500'
})

/** Pointer position → nearest stop. Dragging and clicking the track share one path. */
function stopAt(clientX: number): ReasoningStop | undefined {
  const el = track.value
  const n = model.value.strengths.length
  if (!el || n === 0) return undefined
  const box = el.getBoundingClientRect()
  if (box.width === 0) return model.value.strengths[0]
  const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
  return model.value.strengths[Math.round(ratio * (n - 1))]
}
function onPointerDown(e: PointerEvent) {
  if (!model.value.enabled) return
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  const stop = stopAt(e.clientX)
  if (stop) apply({ kind: 'strength', stop })
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const stop = stopAt(e.clientX)
  if (stop && stop !== model.value.strengths[model.value.index]) apply({ kind: 'strength', stop })
}
function onPointerUp(e: PointerEvent) {
  dragging.value = false
  ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
}
</script>

<template lang="pug">
.relative(@click.stop)
  button.inline-flex.items-center.gap-1.rounded-md.px-2.text-xs.text-muted-foreground(
    type="button" :title="chipTitle" :disabled="!stops.length"
    class="min-h-8 hover:bg-accent hover:text-foreground disabled:opacity-50"
    @click="open = !open")
    Brain(class="size-4")
    span.truncate {{ chipLabel }}
  //- Spec §6: the popover caps itself against the viewport and scrolls its own body.
  .absolute.z-20.mb-2.flex.w-72.flex-col.gap-3.rounded-lg.border.bg-popover.p-3.shadow-lg(
    v-if="open" class="bottom-full right-0 max-h-[60vh] max-w-[85vw] oc-scroll overflow-y-auto")
    .flex.items-center.gap-2
      span.text-sm.font-medium 思考
      Switch(
        :model-value="model.enabled" :disabled="!model.canDisable"
        @update:model-value="apply({ kind: 'enable', on: $event })")
      span.text-xs.text-muted-foreground(v-if="!model.canDisable") 该模型不支持关闭推理
      button.ml-auto.text-xs.text-muted-foreground(
        v-if="canReset" type="button" class="hover:text-foreground"
        @click="emit('update:modelValue', 'inherit')") 默认
    p.truncate.text-xs.text-muted-foreground(v-if="modelName") {{ modelName }}
    .flex.items-center.gap-2
      span.shrink-0.text-xs.text-muted-foreground 自动
      Switch(
        :model-value="model.auto" :disabled="!model.enabled"
        @update:model-value="apply({ kind: 'auto', on: $event })")
      span.ml-auto.truncate.text-xs.text-muted-foreground(v-if="!model.auto && model.enabled") {{ chipLabel }}
    div(:class="!model.enabled || model.auto ? 'pointer-events-none opacity-40' : ''")
      .relative.h-6.cursor-pointer(
        ref="track" @pointerdown="onPointerDown" @pointermove="onPointerMove"
        @pointerup="onPointerUp" @pointercancel="onPointerUp")
        .absolute.h-1.rounded-full(class="left-0 right-0 top-2.5 bg-muted")
        .absolute.h-1.rounded-full(class="left-0 top-2.5" :class="tone" :style="{ width: fill }")
        span.absolute.rounded-full(
          v-for="(s, i) in model.strengths" :key="s"
          class="top-2.5 size-1.5 -translate-x-1/2 bg-muted-foreground/50" :style="{ left: percent(i) }")
        span.absolute.rounded-full.bg-white.shadow(
          v-if="model.index >= 0"
          class="top-1 size-4 -translate-x-1/2 ring-1 ring-black/10" :style="{ left: fill }")
      .flex.justify-between.pt-1
        span.text-xs.text-muted-foreground(v-for="s in model.strengths" :key="s") {{ labelOf(s) }}
</template>
```

- [ ] **Step 2: Swap it into the chat page and delete the old component**

In `src/client/views/chat.vue`, change the import:

```ts
import ReasoningControl from '@/client/components/reasoning-control.vue'
```

and replace the `controls` slot body with:

```pug
    template(#controls)
      ReasoningControl(
        :model-value="form.reasoning" :stops="stops" :model-name="modelName"
        :inherited="inheritedReasoning" :can-reset="form.reasoning !== 'inherit'"
        @update:model-value="onReasoningChange")
```

Delete `src/client/components/reasoning-slider.vue`. Remove the now-unused `ReasoningSlider` import. `SOURCE_LABELS` is still used by `sources.system_prompt` inside `SessionSettings`; leave it.

- [ ] **Step 3: Verify it compiles and nothing dangles**

Run:

```powershell
pnpm typecheck
pnpm build
pnpm test
```

Expected: typecheck and build exit 0; the full suite passes. Then confirm the deleted component has no remaining references:

```powershell
git grep -n "reasoning-slider\|ReasoningSlider"
```

Expected: no output.

- [ ] **Step 4: Look at it, and drive every state**

On a dev server you started, confirm by eye and by clicking:

- The chip shows the current level; with no model it reads 未选择模型 and is disabled with a tooltip.
- Opening the popover shows 思考 on, the model's name, 自动, and the strength axis with every stop named.
- Turning 思考 off greys both the 自动 toggle and the whole slider.
- Turning 自动 on greys the slider and clears the thumb; turning it off lands on the middle stop.
- **Dragging the white thumb** moves it and snaps to stops; clicking anywhere on the track jumps to the nearest stop.
- `默认` appears only after an override and restores inheritance when clicked.
- On a model whose capabilities do not allow disabling, the 思考 switch is disabled and explains why.

Record what you observed. **Do not report this step as done without having actually done it** — this task's whole point is a control nobody has looked at.

- [ ] **Step 5: Commit**

```bash
git add src/client/components/reasoning-control.vue src/client/views/chat.vue
git rm src/client/components/reasoning-slider.vue
git commit -m "feat(chat): rebuild the reasoning control as a switch, a toggle and a strength axis"
```
