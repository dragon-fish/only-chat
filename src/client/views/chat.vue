<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import MessageList from '@/client/components/message-list.vue'
import Composer from '@/client/components/composer.vue'
import { Input } from '@/client/ui/input'
import { Label } from '@/client/ui/label'
import { Textarea } from '@/client/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import type { ModelRef } from '@/shared/api'
import type { Part } from '@/shared/parts'
import type { SessionParams } from '@/shared/models'

/** `reasoning_effort` has no "unset" member, so the picker carries a sentinel option. */
const EFFORT_DEFAULT = 'default'
type EffortChoice = typeof EFFORT_DEFAULT | 'low' | 'medium' | 'high'

const props = defineProps<{ sessionId: number | null }>()
const router = useRouter()
const sync = useSyncStore()
const config = useConfigStore()

const sid = computed(() => props.sessionId)
const session = computed(() => (sid.value === null ? undefined : sync.sessions.get(sid.value)))
const path = computed(() => (sid.value === null ? [] : sync.pathFor(sid.value)))
const streaming = computed(() => sid.value !== null && sync.isStreaming(sid.value))

const model = ref<ModelRef | null>(readModel())
// Only a deliberate pick is remembered globally; adopting a session's model must not overwrite it.
watch(session, (s) => { if (s?.provider_id && s.model_id) model.value = { provider_id: s.provider_id, model_id: s.model_id } }, { immediate: true })
// A remembered model whose provider/model was since deleted or disabled would leave 发送 enabled
// against a model the server will reject; drop it once the config is known.
watch(() => [config.loaded, config.enabledModels().map((e) => `${e.provider.id}:${e.model.model_id}`).join('|')] as const, () => {
  const current = model.value
  if (!config.loaded || !current) return
  if (!config.enabledModels().some((e) => e.provider.id === current.provider_id && e.model.model_id === current.model_id)) model.value = null
}, { immediate: true })

watch(sid, (id) => { if (id !== null) void sync.loadMessages(id) }, { immediate: true })
// Reload on the snapshot itself, not on `status` flipping to `open`: `status` changes before the
// snapshot event is applied, so a reload keyed on it can race ahead and miss messages that only
// the snapshot's reconciliation reveals as finished. `snapshotSeq` starts at 0, so skip that
// initial value — only a later increment means a snapshot actually landed.
watch(() => sync.snapshotSeq, (seq) => { if (seq > 0 && sid.value !== null) void sync.loadMessages(sid.value) })

// A `send` on a fresh page creates the session server-side; jump to it when it appears.
const pendingNew = ref(false)
let pendingTimer: ReturnType<typeof setTimeout> | undefined
watch(() => sync.sessionList[0]?.id, (newest) => {
  if (pendingNew.value && newest !== undefined && sid.value === null) { clearPendingNew(); void router.push(`/c/${newest}`) }
})
// A rejected command never creates the session, so stop waiting for one.
watch(() => sync.lastError, (e) => { if (e) clearPendingNew() })
onBeforeUnmount(clearPendingNew)

const params = reactive({ temperature: '', max_tokens: '', reasoning_effort: EFFORT_DEFAULT as EffortChoice })
watch(() => session.value?.params, (p) => {
  params.temperature = p?.temperature === undefined ? '' : String(p.temperature)
  params.max_tokens = p?.max_tokens === undefined ? '' : String(p.max_tokens)
  params.reasoning_effort = p?.reasoning_effort ?? EFFORT_DEFAULT
}, { immediate: true, deep: true })

function clearPendingNew() {
  pendingNew.value = false
  clearTimeout(pendingTimer)
  pendingTimer = undefined
}

function readModel(): ModelRef | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('oc.model') ?? 'null')
    if (raw === null || typeof raw !== 'object') return null
    const candidate = raw as Partial<ModelRef>
    return typeof candidate.provider_id === 'number' && typeof candidate.model_id === 'string'
      ? { provider_id: candidate.provider_id, model_id: candidate.model_id }
      : null
  } catch { return null }
}

function onSend(parts: Part[]) {
  if (!model.value) return
  if (sid.value === null) {
    pendingNew.value = true
    clearTimeout(pendingTimer)
    pendingTimer = setTimeout(clearPendingNew, 10_000)
  }
  sync.send({ type: 'send', session_id: sid.value, parent_id: session.value?.head_message_id ?? null, parts, ...model.value })
}
function onStop() {
  if (sid.value !== null) sync.send({ type: 'stop', session_id: sid.value })
}
function onModelChange(value: ModelRef | null) {
  model.value = value
  localStorage.setItem('oc.model', JSON.stringify(value))
}
function updateTitle(e: Event) {
  const title = (e.target as HTMLInputElement).value.trim()
  if (sid.value !== null && title) sync.send({ type: 'session.update', session_id: sid.value, title })
}
function updateSystemPrompt(e: Event) {
  const v = (e.target as HTMLTextAreaElement).value
  if (sid.value !== null) sync.send({ type: 'session.update', session_id: sid.value, system_prompt: v || null })
}

function parseNumber(raw: string): number | undefined {
  const t = raw.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}
/** Merges the three edited fields into whatever else the session already carries (e.g. `top_p`). */
function commitParams() {
  if (sid.value === null) return
  const next: SessionParams = { ...(session.value?.params ?? {}) }
  const temperature = parseNumber(params.temperature)
  if (temperature === undefined) delete next.temperature
  else next.temperature = temperature
  const maxTokens = parseNumber(params.max_tokens)
  if (maxTokens === undefined) delete next.max_tokens
  else next.max_tokens = Math.trunc(maxTokens)
  if (params.reasoning_effort === EFFORT_DEFAULT) delete next.reasoning_effort
  else next.reasoning_effort = params.reasoning_effort
  sync.send({ type: 'session.update', session_id: sid.value, params: Object.keys(next).length ? next : null })
}
function onTemperature(e: Event) {
  params.temperature = (e.target as HTMLInputElement).value
  commitParams()
}
function onMaxTokens(e: Event) {
  params.max_tokens = (e.target as HTMLInputElement).value
  commitParams()
}
// reka-ui emits `AcceptableValue`; narrow here rather than in the template.
function onEffort(value: unknown) {
  if (value === EFFORT_DEFAULT || value === 'low' || value === 'medium' || value === 'high') {
    params.reasoning_effort = value
    commitParams()
  }
}
</script>

<template lang="pug">
.flex.h-full.flex-col
  .flex.items-center.gap-2.border-b.px-4.py-2(v-if="session")
    Input(:model-value="session.title" class="h-8 max-w-xs text-sm" @change="updateTitle")
    details.text-xs
      summary.cursor-pointer.text-muted-foreground 会话设置
      .mt-2.flex.flex-col.gap-2
        Textarea(:model-value="session.system_prompt ?? ''" rows="3" class="w-80" placeholder="留空则不发送 system prompt" @change="updateSystemPrompt")
        .flex.flex-wrap.items-center.gap-2
          Label(class="text-xs text-muted-foreground") 温度
          Input(type="number" min="0" max="2" step="0.1" placeholder="默认" class="h-7 w-20 text-xs" :model-value="params.temperature" @change="onTemperature")
          Label(class="text-xs text-muted-foreground") 最大 tokens
          Input(type="number" min="1" step="1" placeholder="默认" class="h-7 w-24 text-xs" :model-value="params.max_tokens" @change="onMaxTokens")
          Label(class="text-xs text-muted-foreground") 推理强度
          Select(:model-value="params.reasoning_effort" @update:model-value="onEffort")
            SelectTrigger(class="h-7 w-24 text-xs")
              SelectValue
            SelectContent
              SelectItem(value="default") 默认
              SelectItem(value="low") low
              SelectItem(value="medium") medium
              SelectItem(value="high") high
  .min-h-0.flex-1
    MessageList(v-if="path.length" :messages="path")
    .flex.h-full.items-center.justify-center.text-muted-foreground(v-else) 开始一段新对话
  Composer(:streaming="streaming" :connected="sync.status === 'open'" :model="model" @update:model="onModelChange" @send="onSend" @stop="onStop")
</template>
