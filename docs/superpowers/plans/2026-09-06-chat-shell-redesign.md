# Chat Shell Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the chat page's shell — a page-owned top bar, a single-card Composer, and a reasoning control whose three non-strength states each get their own single-purpose widget.

**Architecture:** `app-shell.vue` keeps one header row but stops owning its content: it renders the mobile drawer button plus a Teleport target, and each route teleports its own title and actions in. A route component cannot fill a named slot of its layout, because the layout renders it through the default `<slot />` — Teleport is what makes a shell-owned bar with route-owned content possible. The Composer becomes one bordered card holding the textarea and a toolbar row. The reasoning control splits `reasoningStopsFor`'s single list across a 思考 switch, an 自动 toggle, and a strength-only slider, driven by one new pure function that the unit project can test.

**Tech Stack:** Vue 3 (`<script setup>`, Pug SFC templates), Reka UI, Tailwind v4, Pinia, Vite, Vitest, `@lucide/vue`.

**Spec:** `docs/superpowers/specs/2026-09-06-chat-shell-redesign.md`

## Global Constraints

- **Invoke the `shadcn-vue` skill before writing any component, and the `pug-vue-pitfalls` skill before writing any Pug template.** Both are installed in this repo. The shadcn-vue skill carries binding rules this plan does not repeat: no sizing classes on icons nested inside components (they size their own), `data-icon="inline-start"/"inline-end"` for icons beside button text, `gap-*` never `space-y-*`, `cn()` rather than template-literal ternaries, `Separator` rather than a hand-made `h-px` div, `FieldGroup` + `Field` for form layout, and no manual `z-index` on overlays. Where a skill contradicts this plan, the skill wins — say so in the report.
- **Use the vendored components; never hand-roll what the registry ships.** Commit `d5f8ed0` vendored the whole shadcn-vue reka-nova set into `src/client/ui`. Before writing a control, check whether one exists there. The ones this round needs: `input-group` (the Composer card), `attachment` (upload chips, with a per-item `state`), `slider` (reka-ui SliderRoot — already draggable, snapping and keyboard-operable), `field` and `number-field` (settings rows), `popover`, `switch`, `spinner`. Every defect this round has produced so far came from hand-rolling something the registry already solved.
- **Any focusable text control must compute to 16px at mobile widths.** iOS Safari force-zooms a focused input under 16px, which is why the vendored `Input` and `Textarea` carry `text-base md:text-sm`. Do not override that with a bare `text-sm`.
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
- `src/client/components/composer.vue` — `InputGroup` + `InputGroupTextarea` + a block-end `InputGroupAddon` toolbar hosting the attachment button, the `controls` slot and the send button; previews use `AttachmentGroup`/`Attachment`. No hand-written card, border or focus ring.
- `src/client/components/reasoning-control.vue` — **new.** The chip plus its popover: 思考 switch, 自动 toggle, strength slider. Replaces `reasoning-slider.vue`.
- `src/client/components/reasoning-slider.vue` — **deleted** at the end of Task 5.
- `src/client/stores/sync.ts` — gains `reasoningControlModel` and `reasoningChoiceFor`, the pure functions the new component is driven by.
- `test/unit/client-sync-store.test.ts` — covers both new pure functions.
- `src/client/components/session-settings.vue`, `src/client/views/project-settings.vue` — parameter rows move to `Field` + `NumberField` (Task 6).

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

### Task 3: Rebuild the Composer on `InputGroup` and `Attachment`

The Composer's card, its focus ring, its attachment chips and its mobile font size are all
solved by vendored components (commit `d5f8ed0`). This task deletes the hand-rolled versions
rather than restyling them. **Do not write a bordered `div` and do not write `text-sm` on the
textarea** — `InputGroup` owns the border and focus ring, and `Textarea` already carries
`text-base md:text-sm`, which is what stops iOS Safari force-zooming a focused control under
16px.

**Files:**
- Modify: `src/client/components/composer.vue`

**Interfaces:**
- Consumes: `InputGroup`, `InputGroupTextarea`, `InputGroupAddon`, `InputGroupButton` from
  `@/client/ui/input-group`; `Attachment`, `AttachmentGroup`, `AttachmentMedia`,
  `AttachmentAction` from `@/client/ui/attachment`; `Spinner` from `@/client/ui/spinner`.
- Produces: unchanged public surface — props `streaming`, `connected`, `canSend`, `hint`; emits
  `send`, `stop`; exposes `confirmSend()` and `restoreSend()`; slot `controls`. Task 5 renders
  the reasoning chip into that slot, so its name and position must not change.

- [ ] **Step 1: Give each attachment its own upload state**

`Attachment` takes `state: 'idle' | 'uploading' | 'processing' | 'error' | 'done'` and styles
each differently. Today the Composer has one global `上传中…` label and a per-item `failed`
boolean, which cannot say *which* image is still uploading. Widen the item type and push the
placeholder before the upload starts.

In `<script setup>`, replace the `Attached` interface and `addFiles`:

```ts
interface Attached { attachment_id: number; preview: string; state: 'uploading' | 'error' | 'done' }
```

```ts
/** Takes a materialised array: a live `FileList` empties out across the `await`s below. */
async function addFiles(files: File[]) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    // Pushed before the await so the chip appears immediately and can show its own spinner.
    const item = reactive<Attached>({ attachment_id: -1, preview: URL.createObjectURL(f), state: 'uploading' })
    images.value.push(item)
    pending.value++
    try {
      const done = await uploadImage(f)
      item.attachment_id = done.attachment_id
      // `uploadImage` returns its own object URL; drop ours rather than leaking it.
      URL.revokeObjectURL(item.preview)
      item.preview = done.preview
      item.state = 'done'
    }
    catch (err) { console.error(err); item.state = 'error' }
    finally { pending.value-- }
  }
}
```

Add `reactive` to the `vue` import. `pending` and `busy` stay exactly as they are — `busy`
gates `submit()`, and a counter is still the only correct shape for concurrent uploads.

Update the two places that read `failed`:

```ts
const parts: Part[] = images.value.filter((i) => i.state === 'done').map((i) => ({ type: 'image', attachment_id: i.attachment_id }))
```

`releasePreviews` is unchanged.

- [ ] **Step 2: Replace the template**

```pug
<template lang="pug">
.p-3(@drop="onDrop" @dragover.prevent)
  InputGroup.mx-auto(class="max-w-3xl rounded-xl")
    AttachmentGroup.px-2(v-if="images.length")
      Attachment(
        v-for="(img, i) in images" :key="i"
        size="xs" orientation="vertical" :state="img.state")
        AttachmentMedia(variant="image")
          Spinner(v-if="img.state === 'uploading'")
          img(v-else-if="img.state === 'done'" :src="img.preview" alt="")
          X(v-else class="size-4")
        AttachmentAction(title="移除" @click="removeImage(i)")
          X(class="size-3")
    InputGroupTextarea(
      v-model="text" rows="2" placeholder="输入消息…"
      class="max-h-[40vh]"
      @keydown="onKeydown" @paste="onPaste" @input="autoGrow")
    //- `align="block-end"` is what makes InputGroup lay out as a column with this row last.
    InputGroupAddon(align="block-end")
      input.hidden(ref="fileInput" type="file" accept="image/*" multiple @change="onFileChange")
      InputGroupButton(size="icon-xs" title="添加图片" :disabled="busy" @click="fileInput?.click()")
        ImagePlus(class="size-4")
      slot(name="controls")
      .ml-auto.flex.items-center.gap-2
        span.text-xs.text-muted-foreground(v-if="!connected") 未连接
        span.text-xs(v-else-if="hint" class="text-destructive") {{ hint }}
        InputGroupButton(
          v-if="streaming" size="icon-sm" variant="destructive"
          class="rounded-full" title="停止" @click="emit('stop')")
          Square(class="size-4")
        InputGroupButton(
          v-else size="icon-sm" variant="default"
          class="rounded-full" title="发送"
          :disabled="!connected || !canSend || busy" @click="submit")
          Send(class="size-4")
</template>
```

The global `上传中…` label is gone: each chip now shows its own spinner, which is both more
informative and less text in a crowded row.

Update the imports: drop `Button` and `Textarea`, add the four `input-group` components, the
four `attachment` components and `Spinner`.

- [ ] **Step 3: Make the textarea grow with its content**

`InputGroupTextarea` forwards to `Textarea`, which does not auto-grow. Add to `<script setup>`:

```ts
const box = ref<HTMLTextAreaElement | null>(null)

/** Reset before measuring: `scrollHeight` never shrinks on its own. The cap lives in the
 *  template's `max-h-[40vh]`, so past it the element scrolls and this stops changing height. */
function autoGrow() {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
```

`InputGroupTextarea` renders a component, not an element, so `ref="box"` would capture the
component instance. Resolve the element in `autoGrow` instead:

```ts
const box = ref<{ $el?: HTMLTextAreaElement } | HTMLTextAreaElement | null>(null)
function element(): HTMLTextAreaElement | null {
  const r = box.value as { $el?: HTMLTextAreaElement } | HTMLTextAreaElement | null
  if (!r) return null
  return '$el' in r ? (r.$el ?? null) : r
}
```

and have `autoGrow` call `element()`. Add `ref="box"` to the `InputGroupTextarea` line.

Call `autoGrow()` after every programmatic change to `text`: at the end of `submit()` (so the
box collapses back to two rows after sending) and at the end of `restoreSend()` (so a restored
message is fully visible). Both need `await nextTick()` first, because the value has not
rendered yet; make both functions `async` — `submit` is only ever called from event handlers
and `restoreSend` is called through `defineExpose`, so neither caller awaits a result today.
Import `nextTick` from `vue`.

- [ ] **Step 4: Verify it compiles and renders**

Run: `pnpm typecheck && pnpm build`
Expected: both exit 0.

Then confirm the template really produced the components rather than silently dropping them —
Pug parse quirks fail this way. Compile the SFC and assert the render function references them:

```bash
node -e "const fs=require('fs');const p=require.resolve('@vue/compiler-sfc',{paths:[process.cwd()]});const {parse,compileTemplate}=require(p);const src=fs.readFileSync('src/client/components/composer.vue','utf8');const {descriptor,errors}=parse(src);console.log('parse errors:',errors);const r=compileTemplate({source:descriptor.template.content,filename:'composer.vue',id:'x',preprocessLang:'pug'});console.log('compile errors:',r.errors);for(const n of ['InputGroup','InputGroupTextarea','InputGroupAddon','AttachmentGroup'])console.log(n, r.code.includes(n)?'OK':'MISSING')"
```

Expected: both error arrays empty, all four `OK`.

- [ ] **Step 5: Look at it in a browser**

On a dev server you started (**not 5173 or 5199**), at both a desktop width and a 390px-wide
viewport:

- the Composer is one card — textarea and toolbar share a single border, and focusing the
  textarea rings the whole card, not an inner box
- typing past two lines grows the card; past ~40vh the textarea scrolls inside and the card
  stops growing
- attach two images: each chip appears immediately with a spinner, then becomes a thumbnail;
  the remove button works and the previews scroll horizontally rather than wrapping
- send: the box collapses back to two rows
- at 390px, the textarea's computed `font-size` is **16px** (check in devtools — this is the
  iOS force-zoom threshold, and it is the whole reason we use the vendored `Textarea`)

- [ ] **Step 6: Commit**

```bash
git add src/client/components/composer.vue
git commit -m "feat(chat): rebuild the Composer on InputGroup and Attachment"
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

### Task 5: Build the reasoning control on the vendored `Slider`

**Do not write drag logic.** `@/client/ui/slider` wraps reka-ui's `SliderRoot`, which already
drags, snaps to `step`, supports arrow keys and Home/End, and exposes a filled range. The spec's
Codex look is reached by enlarging its thumb through `class`, not by reimplementing it.

**Files:**
- Create: `src/client/components/reasoning-control.vue`
- Modify: `src/client/views/chat.vue`
- Delete: `src/client/components/reasoning-slider.vue`

**Interfaces:**
- Consumes: `reasoningControlModel`, `reasoningChoiceFor`, `ReasoningControlModel`,
  `ReasoningAction`, `REASONING_LABELS`, `reasoningStopsFor` from `@/client/stores/sync`;
  `Popover`, `PopoverTrigger`, `PopoverContent` from `@/client/ui/popover`; `Separator` from `@/client/ui/separator`; `cn` from `@/client/lib/utils`; `Switch` from
  `@/client/ui/switch`; `Slider` from `@/client/ui/slider`; `Button` from `@/client/ui/button`.
- Produces: `<ReasoningControl :capabilities :protocol :active :overridden @update="choice => …" />`,
  rendered into the Composer's `controls` slot.

- [ ] **Step 1: Write the component**

Create `src/client/components/reasoning-control.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { Brain } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import { Separator } from '@/client/ui/separator'
import { Slider } from '@/client/ui/slider'
import { cn } from '@/client/lib/utils'
import { Switch } from '@/client/ui/switch'
import {
  REASONING_LABELS,
  reasoningChoiceFor,
  reasoningControlModel,
  reasoningStopsFor,
} from '@/client/stores/sync'
import type { ReasoningAction, ReasoningChoice } from '@/client/stores/sync'
import type { ModelCapabilities, Protocol } from '@/shared/models'

const props = defineProps<{
  capabilities: ModelCapabilities | null
  protocol: Protocol | null
  /** The effective choice, already resolved through Project inheritance by the parent. */
  active: ReasoningChoice
  /** True when the session overrides its Project, which is what surfaces the 默认 button. */
  overridden: boolean
  /** No model resolved yet — a different disabled reason from "this model cannot reason". */
  noModel: boolean
}>()
const emit = defineEmits<{ update: [choice: ReasoningChoice] }>()

const stops = computed(() => (props.capabilities && props.protocol
  ? reasoningStopsFor(props.capabilities, props.protocol)
  : []))
const model = computed(() => reasoningControlModel(stops.value, props.active))

/** Spec §5.1: a control that cannot act says why; it never silently disappears. */
const disabledReason = computed(() => {
  if (props.noModel) return '先选择模型'
  if (model.value.unsupported) return '该模型不支持推理'
  return null
})

const chipLabel = computed(() => {
  if (!model.value.enabled) return REASONING_LABELS.off
  if (model.value.auto) return REASONING_LABELS.auto
  return REASONING_LABELS[model.value.strengths[model.value.index] ?? 'medium']
})

function act(action: ReasoningAction) {
  emit('update', reasoningChoiceFor(model.value, action))
}

/** reka-ui's Slider is multi-thumb, so it models its value as an array. */
const sliderValue = computed({
  get: () => [model.value.index],
  set: ([i]) => {
    const stop = model.value.strengths[i]
    if (stop) act({ kind: 'strength', stop })
  },
})
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="xs"
        class="gap-1.5"
        :disabled="disabledReason !== null"
        :title="disabledReason ?? '思考强度'"
      >
        <Brain data-icon="inline-start" />
        <span class="text-xs">{{ chipLabel }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">思考</span>
          <Switch
            :model-value="model.enabled"
            :disabled="!model.canDisable"
            :title="model.canDisable ? undefined : '该模型无法关闭思考'"
            @update:model-value="(on: boolean) => act({ kind: 'enable', on })"
          />
        </div>
        <Button v-if="overridden" variant="ghost" size="xs" @click="emit('update', 'inherit')">
          默认
        </Button>
      </div>

      <Separator class="my-3" />

      <div class="flex items-center gap-3">
        <span class="text-sm">自动</span>
        <Switch
          :model-value="model.auto"
          :disabled="!model.enabled"
          @update:model-value="(on: boolean) => act({ kind: 'auto', on })"
        />
      </div>

      <div class="mt-4">
        <Slider
          v-model="sliderValue"
          :min="0"
          :max="Math.max(model.strengths.length - 1, 0)"
          :step="1"
          :disabled="!model.enabled || model.auto"
          class="[&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-track]]:h-1.5"
        />
        <div class="text-muted-foreground mt-2 flex justify-between text-[11px]">
          <span
            v-for="(stop, i) in model.strengths"
            :key="stop"
            :class="cn(!model.enabled || model.auto ? 'opacity-40' : '', i === model.index && model.enabled && !model.auto ? 'text-foreground font-medium' : '')"
          >{{ REASONING_LABELS[stop] }}</span>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
```

This file is deliberately **not** Pug: it carries arbitrary-value Tailwind classes (`[&_[data-slot=…]]`)
and inline TypeScript in handlers, both of which the Global Constraints forbid in Pug templates.
Plain SFC syntax has neither restriction.

- [ ] **Step 2: Wire it into the chat page**

In `src/client/views/chat.vue`, replace the `ReasoningSlider` import and its usage in the
Composer's `controls` slot with `ReasoningControl`, passing the same capability and protocol
values the old slider received, plus `:overridden` (already computable from whether the session's
own params carry a reasoning key) and `:noModel` (true when no effective model resolves).
Keep the `@update` handler wired to the same commit path the old `@update:model-value` used.

- [ ] **Step 3: Delete the old slider**

```bash
git rm src/client/components/reasoning-slider.vue
```

Then `grep -rn "reasoning-slider\|ReasoningSlider" src/` and expect no matches.

- [ ] **Step 4: Verify it compiles**

Run: `pnpm typecheck && pnpm build`
Expected: both exit 0.

- [ ] **Step 5: Look at it in a browser**

On a dev server you started (**not 5173 or 5199**), at a desktop width and at 390px:

- the chip sits in the Composer's toolbar row and reads the current stop by name
- with no model selected, the chip is disabled and its tooltip says 先选择模型
- on a non-reasoning model, disabled with 该模型不支持推理
- **drag the thumb** — it follows the pointer and snaps to stops on release; arrow keys move it too
- turning 思考 off greys both the 自动 switch and the slider
- turning 自动 on greys the slider
- moving the slider turns 自动 off
- 默认 appears only when the session overrides its Project, and clicking it returns to inheritance
- the popover opens without leaving the viewport at either width

- [ ] **Step 6: Commit**

```bash
git add -A src/client/components src/client/views/chat.vue
git commit -m "feat(chat): build the reasoning control on the vendored slider"
```

---

### Task 6: Move the settings forms onto `Field` and `NumberField`

The session- and project-settings forms stack bare labels and inputs with no spacing scale,
which is the "间距完全贴死" the user called out. `Field` supplies the label/description/error
structure and the spacing; `NumberField` supplies a numeric control with real increment and
decrement buttons instead of a raw `<input type="number">` — the same control whose implicit
`v-model` number coercion caused the silent commit failure fixed in `3f015a2`.

**Files:**
- Modify: `src/client/components/session-settings.vue`
- Modify: `src/client/views/project-settings.vue`

**Interfaces:**
- Consumes: `Field`, `FieldLabel`, `FieldDescription`, `FieldGroup` from `@/client/ui/field`;
  `NumberField`, `NumberFieldContent`, `NumberFieldInput`, `NumberFieldDecrement`,
  `NumberFieldIncrement` from `@/client/ui/number-field`.
- Produces: no interface change. `ParamFields` keeps `string | number` for the three numeric
  fields — `NumberField` is `number`-valued, so the union stays correct and `optionalNumber`
  keeps handling both.

- [ ] **Step 1: Read the two components' real props before writing anything**

```bash
cat src/client/ui/field/index.ts src/client/ui/number-field/index.ts
sed -n '1,40p' src/client/ui/number-field/NumberField.vue
```

`NumberField` forwards reka-ui's `NumberFieldRoot`, so `min`, `max`, `step`, `disabled` and
`v-model` are its props — do not invent names. Use what you read.

- [ ] **Step 2: Convert `session-settings.vue`**

Wrap the whole form in a single `FieldGroup` and each row in a `Field` with a `FieldLabel` — the skill's forms rule forbids a raw `div` with `space-y-*` or `grid gap-*` for form layout, and replace the three
`Input(v-model="form.x" type="number" …)` lines with `NumberField`, carrying the same `min`,
`max` and `step` values that are on them today (temperature 0–2 step 0.1; top_p 0–1 step 0.05;
max_tokens min 1 step 1). Keep every `@change="emit('commit')"` binding — `NumberField` emits
`update:modelValue`, so commit on that instead, and verify the commit still fires.

`Field` also carries `FieldDescription`; use it for the "留空则继承" hints that are currently
inline text, rather than leaving them as bare spans.

- [ ] **Step 3: Convert `project-settings.vue` the same way**

Its three numeric inputs are the same three fields with the same ranges. It uses `placeholder="继承"`
today; that becomes a `FieldDescription`.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm build`
Expected: both exit 0.

- [ ] **Step 5: Look at it in a browser, and prove the values still persist**

This is the exact path that silently lost data before `3f015a2`, so verify by *use*, not by diff:

- set temperature, top_p and max_tokens in session settings, reload the page, confirm all three
  came back
- do the same in project settings
- confirm the increment/decrement buttons respect the min/max bounds
- confirm rows have breathing room at 390px as well as desktop

- [ ] **Step 6: Run the full unit suite and commit**

```bash
pnpm test
git add src/client/components/session-settings.vue src/client/views/project-settings.vue
git commit -m "feat(settings): move the parameter forms onto Field and NumberField"
```
