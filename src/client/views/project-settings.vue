<script setup lang="ts">
import { computed, reactive, ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/client/ui/tabs'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { useFormChanges } from '@/client/composables/use-form-changes'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Button } from '@/client/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from '@/client/ui/number-field'
import { Textarea } from '@/client/ui/textarea'
import { Skeleton } from '@/client/ui/skeleton'
import { Spinner } from '@/client/ui/spinner'
import ModelPicker from '@/client/components/model-picker.vue'
import ReasoningControls from '@/client/components/reasoning-controls.vue'
import ProjectIconEditor from '@/client/components/project-icon-editor.vue'
import ProjectPluginPanel from '@/client/components/project-plugin-panel.vue'
import { projectTabs } from '@/shared/plugins'
import { pluginManifests } from '@/shared/plugin-manifests'
import { DISCONNECTED_MESSAGE, fieldLooksBlank, optionalNumber, projectFormFrom, projectUpdateCommand, reasoningStopsFor, REASONING_ORDER, useSyncStore, type ProjectFormState } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import { projectPresentation } from '@/client/lib/ui-models'
import { useRouteOverlay } from '@/client/composables/use-route-overlay'

const props = defineProps<{ projectId: number | null }>()
const router = useRouter()
const sync = useSyncStore()
const config = useConfigStore()

/** `plugin:<id>` for a plugin's own tab; those save themselves rather than through 保存 below. */
type SectionKey = 'basic' | 'model' | `plugin:${string}`
const pluginTabs = computed(() => projectTabs(pluginManifests, sync.settings.plugins))
const sections = computed((): Array<{ key: SectionKey, label: string }> => [
  { key: 'basic', label: '基本' },
  { key: 'model', label: '模型与参数' },
  ...pluginTabs.value.map(tab => ({ key: `plugin:${tab.pluginId}` as const, label: tab.label })),
])
const sectionPlugin = computed(() => (section.value.startsWith('plugin:') ? section.value.slice('plugin:'.length) : null))

const section = ref<SectionKey>('basic')
const routeOverlay = useRouteOverlay(() => (
  props.projectId === null ? '/projects' : `/project/${props.projectId}`
))
const overlayOpen = routeOverlay.open
const leaveGuard = ref<InstanceType<typeof UnsavedChangesGuard> | null>(null)
const form = reactive<ProjectFormState>(projectFormFrom(undefined))
const loaded = ref(false)
const missing = ref(false)
const saving = ref(false)
const deleting = ref(false)
const loadError = ref<string | null>(null)
/** The `updated_at` we saved against; the round trip ends when the store's row moves off it. */
let savedAgainst = 0
let savedSnapshot = ''

const project = computed(() => (props.projectId === null ? undefined : sync.projects.get(props.projectId)))
const projectTitle = computed(() => project.value ? projectPresentation(project.value.name).title : '项目设置')
/** 保存 is gated on the socket exactly as the Composer gates 发送: no round trip, no wait to latch. */
const connected = computed(() => sync.status === 'open')
const defaultModel = computed(() => config.modelFor(form.model))
/**
 * With a default model set, only the levels it declares may be saved (spec §3.3). With no default
 * model there is nothing to validate against, so every level stays reachable and the note says so.
 */
const stops = computed(() => form.model
  ? reasoningStopsFor(defaultModel.value?.model.metadata)
  : [...REASONING_ORDER])
const chatCount = computed(() => (props.projectId === null ? 0 : sync.conversationsInProject(props.projectId).length))

/**
 * The live text of each box while it is being edited, `null` when it is not. reka only writes typed
 * text back to the model on blur or Enter, so the model is the wrong thing to ask whether the box
 * the user is looking at is empty — see `fieldLooksBlank`.
 */
const typing = reactive<Record<ParamKey, string | null>>({ temperature: null, top_p: null, max_tokens: null })
const { dirty, capture, markSaved } = useFormChanges(() => ({
  ...form,
  temperature: typing.temperature ?? String(form.temperature),
  top_p: typing.top_p ?? String(form.top_p),
  max_tokens: typing.max_tokens ?? String(form.max_tokens),
}))
// Declared above `initialize` on purpose: an immediate watcher calls that function synchronously
// during setup, so a `const` declared further down would still be in its temporal dead zone.

/**
 * Every piece of state here belongs to one `projectId`, and vue-router reuses this instance for a
 * param-only navigation, so re-initialising has to be driven by the prop rather than by mounting:
 * clicking a second Project's ✏️ used to keep the first Project's values in the form and then save
 * them onto the second. The token makes a stale async continuation from the previous id a no-op.
 */
let initToken = 0
async function initialize(): Promise<void> {
  const token = ++initToken
  Object.assign(form, projectFormFrom(undefined))
  // The form is being replaced, so any in-flight box text belongs to the previous Project.
  Object.assign(typing, { temperature: null, top_p: null, max_tokens: null })
  loaded.value = false
  missing.value = false
  saving.value = false
  deleting.value = false
  loadError.value = null
  savedAgainst = 0
  section.value = 'basic'
  overlayOpen.value = true
  try {
    if (!config.loaded) await config.load()
    if (token !== initToken) return
    // Direct URL loads can beat the boot fetch, so confirm absence before showing the empty state.
    if (!project.value) await sync.loadProjects()
    if (token !== initToken) return
    if (!project.value) missing.value = true
  } catch (error) {
    if (token === initToken) loadError.value = error instanceof Error ? error.message : String(error)
  }
}

watch(() => props.projectId, initialize, { immediate: true })

// Populated once per Project: a concurrent update from another device must not overwrite what is
// being typed. `initialize` clears `loaded` first, so the next Project refills the form.
watchEffect(() => {
  const p = project.value
  if (p && !loaded.value) { Object.assign(form, projectFormFrom(p)); loaded.value = true; markSaved() }
})

// Leaving is driven by the server: `project.deleted` (ours or another device's) removes the row.
watchEffect(() => {
  if (loaded.value && !project.value) {
    if (deleting.value) toast.success('已删除项目，对话已移到随心聊')
    markSaved()
    void router.push('/chats')
  }
})

// The save round trip completes on `project.updated`, not on the click (spec §7.2).
watchEffect(() => {
  const p = project.value
  if (saving.value && p && p.updated_at !== savedAgainst) {
    saving.value = false
    markSaved(savedSnapshot)
    toast.success('已保存项目')
    routeOverlay.setOpen(false)
  }
})

// Errors are broadcast without a `request_id`, so any rejection ends the wait; the form keeps
// everything the user typed and the global toaster shows the message (spec §9).
watch(() => sync.lastError, (err) => { if (err !== null) { saving.value = false; deleting.value = false } })
watch(connected, value => {
  if (!value && (saving.value || deleting.value)) {
    saving.value = false
    deleting.value = false
    sync.lastError = DISCONNECTED_MESSAGE
  }
})

function selectSection(value: unknown) {
  if (sections.value.some(item => item.key === value)) section.value = value as SectionKey
}

async function setOverlayOpen(next: boolean) {
  if (next) { routeOverlay.setOpen(true); return }
  if (dirty.value && !(await leaveGuard.value?.confirmLeave())) return
  // A confirmed discard must not trigger the route guard a second time after the leave animation.
  if (dirty.value) markSaved()
  routeOverlay.setOpen(false)
}

function save() {
  const p = project.value
  if (!p || !form.name.trim() || saving.value || deleting.value) return
  savedAgainst = p.updated_at
  savedSnapshot = capture()
  saving.value = true
  sync.lastError = null
  // A command that never reaches an open socket is never answered by `project.updated`, and there
  // is no `request_id` to time out against. Latching the wait anyway is what left 保存 dead until
  // the page was navigated away from, so an undeliverable save ends here and says so (spec §9).
  if (!connected.value || !sync.send(projectUpdateCommand(p.id, form))) {
    saving.value = false
    sync.lastError = DISCONNECTED_MESSAGE
  }
}

function onDelete() {
  const p = project.value
  if (!p || deleting.value || saving.value) return
  // The Project's chats are not deleted with it; they reappear under Chats (spec §3.1).
  sync.lastError = null
  if (!connected.value || !sync.send({ type: 'project.delete', project_id: p.id })) {
    sync.lastError = DISCONNECTED_MESSAGE
    return
  }
  deleting.value = true
}

type ParamKey = 'temperature' | 'top_p' | 'max_tokens'

/**
 * Blank means "inherit", so no stepper may turn it into a value. reka's `handleChangingValue`
 * writes `clampInputValue(min ?? 0)` whenever the input is empty and disables neither stepper
 * there, so one press of + on a blank box silently filled it with the bound. The conversation form
 * commits on the spot and made that immediate data loss; here it only waits for 保存, which is the
 * same lie one click later. Same guard on both pages: the two buttons are disabled while blank,
 * and this covers what has no button — reka routes ArrowUp/ArrowDown, PageUp/PageDown, Home/End
 * and the wheel through the same handlers. Capture phase, so it runs before reka's listeners on
 * the input; `stopPropagation` only, never `preventDefault`, so the caret and the page's own
 * scrolling still behave normally.
 */
const STEP_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])

/** Blank is `''` in the form and `undefined` through `optionalNumber` — never `0`. */
function onType(field: ParamKey, event: Event) {
  typing[field] = (event.target as HTMLInputElement).value
}
/** Blur is where reka reconciles text and model, so the model becomes authoritative again. */
function onSettle(field: ParamKey) {
  typing[field] = null
}
function blank(field: ParamKey): boolean {
  return fieldLooksBlank(typing[field], form[field])
}
function guardStep(field: ParamKey, event: Event) {
  if (!blank(field)) return
  if (event instanceof KeyboardEvent && !STEP_KEYS.has(event.key)) return
  event.stopPropagation()
}
/** The steppers are disabled while the box is blank; say why rather than leave two dead buttons. */
function paramHint(field: ParamKey): string {
  const base = '留空则继承，不写入项目参数。'
  return blank(field) ? `${base}+/- 需先填入数值。` : base
}

/**
 * `NumberField` clears to `undefined`; the field keeps holding `''` for blank so that
 * `projectParamsFromForm` drops the key instead of saving a value the Project never chose.
 */
function setParam(field: ParamKey, value: number | undefined) {
  form[field] = value ?? ''
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}
</script>

<template lang="pug">
ResponsiveOverlay(
  mode="dialog" :open="overlayOpen" :title="projectTitle" @update:open="setOverlayOpen")
  template(#status)
    UnsavedChangesGuard(ref="leaveGuard" :dirty="dirty")
  Alert(v-if="loadError" variant="destructive")
    AlertTitle 无法加载项目设置
    AlertDescription
      p {{ loadError }}
      Button(variant="outline" class="min-h-10 mt-2" @click="initialize") 重试
  template(v-else-if="project")
    Tabs(:model-value="section" @update:model-value="selectSection")
      TabsList(class="mb-4")
        TabsTrigger(v-for="item in sections" :key="item.key" :value="item.key" class="min-h-10") {{ item.label }}
    FieldGroup(v-if="section === 'basic'")
        Field
          FieldLabel Project 图标
          ProjectIconEditor(
            :name="form.name" :attachment-id="form.icon_attachment_id"
            @update:attachment-id="form.icon_attachment_id = $event")
          FieldDescription 可上传并裁剪为 200×200 图片；未上传图片时，名称开头的 Emoji 会自动成为图标。
        Field
          FieldLabel(for="oc-project-name") 名称
          Input(id="oc-project-name" v-model="form.name" placeholder="项目名称" class="min-h-10" required maxlength="100")
        Field(class="min-h-0")
          FieldLabel(for="oc-project-prompt") Project prompt
          Textarea(
            id="oc-project-prompt" v-model="form.system_prompt" class="min-h-40"
            placeholder="留空表示不附加项目提示词")
          FieldDescription 会话开始生成时，项目提示词在前、会话提示词在后，中间固定两个换行。
    ProjectPluginPanel(v-else-if="sectionPlugin" :key="sectionPlugin" :plugin-id="sectionPlugin" :project-id="project.id")
    FieldGroup(v-else)
        Field
          FieldLabel 默认模型
          .flex.flex-wrap.items-center.gap-2
            ModelPicker(v-model="form.model")
            Badge(variant="outline") {{ form.model ? '项目默认' : '未设置' }}
            Button(v-if="form.model" type="button" variant="ghost" size="xs" class="min-h-10" @click="form.model = null") 清除
          FieldDescription 留空表示不设置默认模型，由会话或发送时的选择决定。
        Field
          .flex.items-center.justify-between.gap-2
            FieldLabel(for="oc-project-temperature") temperature
            Badge(variant="outline") {{ blank('temperature') ? '继承' : '项目设置' }}
          //- `step` sizes the +/- buttons only: `step-snapping` off is what lets a typed 0.77 stay
          //- 0.77 instead of being rewritten to the nearest step, which is how the raw box behaved.
          //- `maximumFractionDigits` is 20, not a guess at what people type: a double carries at most
          //- 17 significant digits, so 20 fractional digits cannot lose one. reka round-trips every value
          //- through `Intl.NumberFormat`, whose default of 3 rewrote a stored 0.6667 to 0.667.
          NumberField(
            id="oc-project-temperature" :model-value="optionalNumber(form.temperature)"
            :min="0" :max="2" :step="0.1" :step-snapping="false" :disable-wheel-change="true"
            :format-options="{ maximumFractionDigits: 20 }"
            @update:model-value="setParam('temperature', $event)"
            @keydown.capture="guardStep('temperature', $event)"
            @wheel.capture="guardStep('temperature', $event)")
            NumberFieldContent
              NumberFieldDecrement(:disabled="blank('temperature')")
              NumberFieldInput(class="min-h-10" @input="onType('temperature', $event)" @blur="onSettle('temperature')")
              NumberFieldIncrement(:disabled="blank('temperature')")
          FieldDescription {{ paramHint('temperature') }}
        Field
          .flex.items-center.justify-between.gap-2
            FieldLabel(for="oc-project-top-p") top_p
            Badge(variant="outline") {{ blank('top_p') ? '继承' : '项目设置' }}
          NumberField(
            id="oc-project-top-p" :model-value="optionalNumber(form.top_p)"
            :min="0" :max="1" :step="0.05" :step-snapping="false" :disable-wheel-change="true"
            :format-options="{ maximumFractionDigits: 20 }"
            @update:model-value="setParam('top_p', $event)"
            @keydown.capture="guardStep('top_p', $event)"
            @wheel.capture="guardStep('top_p', $event)")
            NumberFieldContent
              NumberFieldDecrement(:disabled="blank('top_p')")
              NumberFieldInput(class="min-h-10" @input="onType('top_p', $event)" @blur="onSettle('top_p')")
              NumberFieldIncrement(:disabled="blank('top_p')")
          FieldDescription {{ paramHint('top_p') }}
        Field
          .flex.items-center.justify-between.gap-2
            FieldLabel(for="oc-project-max-tokens") max tokens
            Badge(variant="outline") {{ blank('max_tokens') ? '继承' : '项目设置' }}
          NumberField(
            id="oc-project-max-tokens" :model-value="optionalNumber(form.max_tokens)"
            :min="1" :step="1" :step-snapping="false" :disable-wheel-change="true" :format-options="{ useGrouping: false }"
            @update:model-value="setParam('max_tokens', $event)"
            @keydown.capture="guardStep('max_tokens', $event)"
            @wheel.capture="guardStep('max_tokens', $event)")
            NumberFieldContent
              NumberFieldDecrement(:disabled="blank('max_tokens')")
              NumberFieldInput(class="min-h-10" @input="onType('max_tokens', $event)" @blur="onSettle('max_tokens')")
              NumberFieldIncrement(:disabled="blank('max_tokens')")
          FieldDescription {{ paramHint('max_tokens') }}
        Field
          .flex.items-center.justify-between.gap-2
            FieldLabel 推理强度
            Badge(variant="outline") {{ form.reasoning === 'inherit' ? '继承' : '项目设置' }}
          //- Rendered inline, not behind a chip and an overlay. That shape belongs to the Composer's
          //- toolbar, which is one row with no space for two switches and a slider; a settings page
          //- has the room, and every field beside this one is laid out plainly.
          ReasoningControls(
            :stops="stops" :active="form.reasoning" :overridden="form.reasoning !== 'inherit'"
            @update="form.reasoning = $event")
          //- An empty axis is not a filter result: it means the default model declares no
          //- reasoning at all, and saying 只显示…声明支持的档位 there reads as "this model
          //- supports none of them" rather than "this model does not reason".
          FieldDescription(v-if="!form.model") 未设置默认模型时无法校验档位，实际可用范围由发送时的模型决定。
          FieldDescription(v-else-if="stops.length === 0") 该默认模型未声明推理能力，此处没有可设置的档位；改用其他默认模型才能设置。
          FieldDescription(v-else) 只显示该默认模型声明支持的档位；「默认」表示项目不设置推理档位。
  Empty(v-else-if="missing" class="min-h-32")
    EmptyHeader
      EmptyTitle 项目不存在
      EmptyDescription 这个项目不存在或已被删除。
    EmptyContent
      Button(variant="outline" class="min-h-10" @click="router.push('/projects')") 查看项目
  .flex.min-h-32.flex-col.gap-3(v-else role="status" aria-label="正在加载项目设置")
    Skeleton(class="h-5 w-32")
    Skeleton(class="h-8 w-full")
    Skeleton(class="h-20 w-full")
    span.sr-only 加载中…
  template(#footer v-if="project && !loadError")
    p.text-xs.text-muted-foreground
      | {{ chatCount }} 个聊天 · 创建于 {{ formatTime(project.created_at) }} · 更新于 {{ formatTime(project.updated_at) }}
    .flex.items-center.justify-end.gap-2
      AlertDialog
        AlertDialogTrigger(as-child)
          Button(type="button" size="sm" variant="destructive" class="min-h-10" :disabled="saving || deleting || !connected") {{ deleting ? '删除中…' : '删除项目' }}
        AlertDialogContent
          AlertDialogHeader
            AlertDialogTitle 删除这个 Project？
            AlertDialogDescription “{{ project.name }}”将被删除，其中的对话会移到随心聊。
          AlertDialogFooter
            AlertDialogCancel(class="min-h-10") 取消
            AlertDialogAction(class="min-h-10" variant="destructive" :disabled="saving || deleting || !connected" @click="onDelete") 删除
      Button(
        size="sm" class="min-h-10" :disabled="!form.name.trim() || saving || deleting || !connected"
        :title="connected ? undefined : DISCONNECTED_MESSAGE" @click="save")
        Spinner(v-if="saving" data-icon="inline-start")
        | {{ saving ? '保存中…' : '保存' }}
</template>
