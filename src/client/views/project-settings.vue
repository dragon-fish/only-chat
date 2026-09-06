<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch, watchEffect } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'
import { Label } from '@/client/ui/label'
import { Textarea } from '@/client/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import ModelPicker from '@/client/components/model-picker.vue'
import { projectUpdateCommand, useSyncStore, type ProjectFormState, type ProjectReasoningChoice } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import type { Project, SessionParams } from '@/shared/models'

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

const reasoningOptions: Array<{ value: ProjectReasoningChoice; label: string }> = [
  { value: 'inherit', label: '继承（不设置）' },
  { value: 'off', label: '立即（关闭推理）' },
  { value: 'auto', label: '自动（开启，不指定强度）' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
]

const section = ref<SectionKey>('basic')
const form = reactive<ProjectFormState>({ name: '', system_prompt: '', model: null, temperature: '', top_p: '', max_tokens: '', reasoning: 'inherit' })
const loaded = ref(false)
const missing = ref(false)
const saving = ref(false)
const pendingDelete = ref(false)
let pendingTimer: ReturnType<typeof setTimeout> | undefined
/** The `updated_at` we saved against; the round trip ends when the store's row moves off it. */
let savedAgainst = 0

const project = computed(() => (props.projectId === null ? undefined : sync.projects.get(props.projectId)))
const chatCount = computed(() => (props.projectId === null ? 0 : sync.sessionsInProject(props.projectId).length))

/** A merged control: `reasoning_enabled` and `reasoning_effort` are stored apart (spec §3.3). */
function reasoningChoiceOf(params: SessionParams): ProjectReasoningChoice {
  if (params.reasoning_enabled === false) return 'off'
  if (params.reasoning_enabled === undefined && params.reasoning_effort === undefined) return 'inherit'
  return params.reasoning_effort ?? 'auto'
}

function numberToField(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

function fillForm(p: Project): void {
  const params = p.params ?? {}
  Object.assign(form, {
    name: p.name,
    system_prompt: p.system_prompt ?? '',
    // A Project without a default model shows an empty picker — never the inherited fallback.
    model: p.provider_id !== null && p.model_id !== null ? { provider_id: p.provider_id, model_id: p.model_id } : null,
    temperature: numberToField(params.temperature),
    top_p: numberToField(params.top_p),
    max_tokens: numberToField(params.max_tokens),
    reasoning: reasoningChoiceOf(params),
  } satisfies ProjectFormState)
}

onMounted(async () => {
  if (!config.loaded) await config.load()
  // Direct URL loads can beat the boot fetch, so make sure the row really is absent before giving up.
  if (!project.value) await sync.loadProjects()
  if (!project.value) missing.value = true
})

// Populated once: a concurrent update from another device must not overwrite what is being typed.
watchEffect(() => {
  const p = project.value
  if (p && !loaded.value) { fillForm(p); loaded.value = true }
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

function onReasoningChange(value: unknown) {
  const option = reasoningOptions.find((o) => o.value === value)
  if (option) form.reasoning = option.value
}

function save() {
  const p = project.value
  if (!p || !form.name.trim() || saving.value) return
  savedAgainst = p.updated_at
  saving.value = true
  sync.lastError = null
  sync.send(projectUpdateCommand(p.id, form))
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
  nav.flex.w-32.shrink-0.flex-col.gap-1.border-r.p-2(class="sm:w-44 sm:p-3")
    RouterLink.mb-2.text-xs.text-muted-foreground(to="/") ← 返回
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
          Select(:model-value="form.reasoning" @update:model-value="onReasoningChange")
            SelectTrigger(class="w-56")
              SelectValue
            SelectContent
              SelectItem(v-for="o in reasoningOptions" :key="o.value" :value="o.value") {{ o.label }}
          p.mt-1.text-xs.text-muted-foreground 继承表示项目不设置推理档位，由会话或模型默认决定。
    .flex.items-center.gap-3.border-t.p-3
      p.min-w-0.truncate.text-xs.text-muted-foreground
        | {{ chatCount }} 个聊天 · 创建于 {{ formatTime(project.created_at) }} · 更新于 {{ formatTime(project.updated_at) }}
      button.ml-auto.shrink-0.text-xs(class="text-destructive" @click="onDelete")
        | {{ pendingDelete ? '确认删除项目' : '删除项目' }}
      Button(size="sm" :disabled="!form.name.trim() || saving" @click="save") {{ saving ? '保存中…' : '保存' }}
  .flex.min-h-0.flex-1.items-center.justify-center.p-4.text-sm.text-muted-foreground(v-else)
    | {{ missing ? '项目不存在或已被删除。' : '加载中…' }}
</template>
