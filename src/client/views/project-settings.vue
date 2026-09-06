<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch, watchEffect } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'
import { Label } from '@/client/ui/label'
import { Textarea } from '@/client/ui/textarea'
import ModelPicker from '@/client/components/model-picker.vue'
import ReasoningControl from '@/client/components/reasoning-control.vue'
import { DISCONNECTED_MESSAGE, projectFormFrom, projectUpdateCommand, reasoningStopsFor, REASONING_ORDER, useSyncStore, type ProjectFormState } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'

const props = defineProps<{ projectId: number | null }>()
const router = useRouter()
const sync = useSyncStore()
const config = useConfigStore()

/** v1 renders only the sections that exist; the nav column is the growth slot (spec §7.2). */
const sections = [
  { key: 'basic', label: '基本' },
  { key: 'model', label: '模型与参数' },
] as const
type SectionKey = (typeof sections)[number]['key']

const section = ref<SectionKey>('basic')
const form = reactive<ProjectFormState>(projectFormFrom(undefined))
const loaded = ref(false)
const missing = ref(false)
const saving = ref(false)
const pendingDelete = ref(false)
let pendingTimer: ReturnType<typeof setTimeout> | undefined
/** The `updated_at` we saved against; the round trip ends when the store's row moves off it. */
let savedAgainst = 0

const project = computed(() => (props.projectId === null ? undefined : sync.projects.get(props.projectId)))
/** 保存 is gated on the socket exactly as the Composer gates 发送: no round trip, no wait to latch. */
const connected = computed(() => sync.status === 'open')
const defaultModel = computed(() => config.modelFor(form.model))
/**
 * With a default model set, only the levels it declares may be saved (spec §3.3). With no default
 * model there is nothing to validate against, so every level stays reachable and the note says so.
 */
const stops = computed(() => form.model
  ? reasoningStopsFor(defaultModel.value?.model.capabilities, defaultModel.value?.provider.protocol)
  : [...REASONING_ORDER])
const chatCount = computed(() => (props.projectId === null ? 0 : sync.sessionsInProject(props.projectId).length))

/**
 * Every piece of state here belongs to one `projectId`, and vue-router reuses this instance for a
 * param-only navigation, so re-initialising has to be driven by the prop rather than by mounting:
 * clicking a second Project's ✏️ used to keep the first Project's values in the form and then save
 * them onto the second. The token makes a stale async continuation from the previous id a no-op.
 */
let initToken = 0
async function initialize(): Promise<void> {
  const token = ++initToken
  clearPending()
  Object.assign(form, projectFormFrom(undefined))
  loaded.value = false
  missing.value = false
  saving.value = false
  savedAgainst = 0
  section.value = 'basic'
  if (!config.loaded) await config.load()
  if (token !== initToken) return
  // Direct URL loads can beat the boot fetch, so make sure the row really is absent before giving up.
  if (!project.value) await sync.loadProjects()
  if (token !== initToken) return
  if (!project.value) missing.value = true
}

watch(() => props.projectId, initialize, { immediate: true })

// Populated once per Project: a concurrent update from another device must not overwrite what is
// being typed. `initialize` clears `loaded` first, so the next Project refills the form.
watchEffect(() => {
  const p = project.value
  if (p && !loaded.value) { Object.assign(form, projectFormFrom(p)); loaded.value = true }
})

// Leaving is driven by the server: `project.deleted` (ours or another device's) removes the row.
watchEffect(() => {
  if (loaded.value && !project.value) router.push('/')
})

// The save round trip completes on `project.updated`, not on the click (spec §7.2).
watchEffect(() => {
  const p = project.value
  if (saving.value && p && p.updated_at !== savedAgainst) { saving.value = false; router.push('/') }
})

// Errors are broadcast without a `request_id`, so any rejection ends the wait; the form keeps
// everything the user typed and the shell shows the message (spec §9).
watch(() => sync.lastError, (err) => { if (err !== null) saving.value = false })

function save() {
  const p = project.value
  if (!p || !form.name.trim() || saving.value) return
  savedAgainst = p.updated_at
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

function clearPending() {
  pendingDelete.value = false
  clearTimeout(pendingTimer)
}

function onDelete() {
  const p = project.value
  if (!p) return
  if (!pendingDelete.value) {
    pendingDelete.value = true
    pendingTimer = setTimeout(clearPending, 3000)
    return
  }
  clearPending()
  // The Project's chats are not deleted with it; they reappear under Chats (spec §3.1).
  sync.send({ type: 'project.delete', project_id: p.id })
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

onUnmounted(clearPending)
</script>

<template lang="pug">
//- Spec §8: the page root owns the height, the form body is the only vertical scroller.
.flex.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header")
    RouterLink.shrink-0.text-muted-foreground(to="/" class="hover:text-foreground") ←
    span.truncate.text-sm.font-medium {{ project?.name ?? '项目设置' }}
  nav.flex.w-32.shrink-0.flex-col.gap-1.border-r.p-2(class="sm:w-44 sm:p-3")
    button.rounded-md.px-2.py-1.text-left.text-sm(
      v-for="s in sections" :key="s.key"
      :class="section === s.key ? 'bg-accent font-medium' : 'hover:bg-accent'"
      @click="section = s.key") {{ s.label }}
  .flex.min-h-0.min-w-0.flex-1.flex-col(v-if="project")
    .oc-scroll.flex.min-h-0.flex-1.flex-col.gap-4.overflow-y-auto.p-4
      template(v-if="section === 'basic'")
        div
          Label 名称
          Input(v-model="form.name" placeholder="项目名称")
        .flex.min-h-0.flex-col
          Label Project prompt
          Textarea(v-model="form.system_prompt" class="min-h-40" placeholder="留空表示不附加项目提示词")
          p.mt-1.text-xs.text-muted-foreground 会话开始生成时，项目提示词在前、会话提示词在后，中间固定两个换行。
      template(v-else)
        div
          Label 默认模型
          .flex.items-center.gap-2
            ModelPicker(v-model="form.model")
            button.text-xs.text-muted-foreground(v-if="form.model" class="hover:text-foreground" @click="form.model = null") 清除
          p.mt-1.text-xs.text-muted-foreground 留空表示不设置默认模型，由会话或发送时的选择决定。
        .grid.grid-cols-3.gap-3
          div
            Label temperature
            Input(v-model="form.temperature" type="number" min="0" max="2" step="0.1" placeholder="继承")
          div
            Label top_p
            Input(v-model="form.top_p" type="number" min="0" max="1" step="0.05" placeholder="继承")
          div
            Label max tokens
            Input(v-model="form.max_tokens" type="number" min="1" step="1" placeholder="继承")
        div
          Label 推理强度
          .mt-1
            ReasoningControl(
              :stops="stops" :active="form.reasoning" :overridden="form.reasoning !== 'inherit'"
              :no-model="false" @update="form.reasoning = $event")
          p.mt-1.text-xs.text-muted-foreground(v-if="form.model") 只显示该默认模型声明支持的档位；「默认」表示项目不设置推理档位。
          p.mt-1.text-xs.text-muted-foreground(v-else) 未设置默认模型时无法校验档位，实际可用范围由发送时的模型决定。
    .flex.items-center.gap-3.border-t.p-3
      p.min-w-0.truncate.text-xs.text-muted-foreground
        | {{ chatCount }} 个聊天 · 创建于 {{ formatTime(project.created_at) }} · 更新于 {{ formatTime(project.updated_at) }}
      button.ml-auto.shrink-0.text-xs(class="text-destructive" @click="onDelete")
        | {{ pendingDelete ? '确认删除项目' : '删除项目' }}
      Button(
        size="sm" :disabled="!form.name.trim() || saving || !connected"
        :title="connected ? undefined : DISCONNECTED_MESSAGE" @click="save") {{ saving ? '保存中…' : '保存' }}
  .flex.min-h-0.flex-1.items-center.justify-center.p-4.text-sm.text-muted-foreground(v-else)
    | {{ missing ? '项目不存在或已被删除。' : '加载中…' }}
</template>
