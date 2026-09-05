<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import MessageList from '@/client/components/message-list.vue'
import Composer from '@/client/components/composer.vue'
import { Input } from '@/client/ui/input'
import { Textarea } from '@/client/ui/textarea'
import { useSyncStore } from '@/client/stores/sync'
import type { ModelRef } from '@/shared/api'
import type { Part } from '@/shared/parts'

const props = defineProps<{ sessionId: number | null }>()
const router = useRouter()
const sync = useSyncStore()

const sid = computed(() => props.sessionId)
const session = computed(() => (sid.value === null ? undefined : sync.sessions.get(sid.value)))
const path = computed(() => (sid.value === null ? [] : sync.pathFor(sid.value)))
const streaming = computed(() => sid.value !== null && sync.isStreaming(sid.value))

const model = ref<ModelRef | null>(readModel())
watch(model, (m) => localStorage.setItem('oc.model', JSON.stringify(m)))
watch(session, (s) => { if (s?.provider_id && s.model_id) model.value = { provider_id: s.provider_id, model_id: s.model_id } }, { immediate: true })

watch(sid, (id) => { if (id !== null) void sync.loadMessages(id) }, { immediate: true })
watch(() => sync.status, (s) => { if (s === 'open' && sid.value !== null) void sync.loadMessages(sid.value) })

// A `send` on a fresh page creates the session server-side; jump to it when it appears.
const pendingNew = ref(false)
watch(() => sync.sessionList[0]?.id, (newest) => {
  if (pendingNew.value && newest !== undefined && sid.value === null) { pendingNew.value = false; void router.push(`/c/${newest}`) }
})

function readModel(): ModelRef | null {
  try { return JSON.parse(localStorage.getItem('oc.model') ?? 'null') as ModelRef | null } catch { return null }
}

function onSend(parts: Part[]) {
  if (!model.value) return
  if (sid.value === null) pendingNew.value = true
  sync.send({ type: 'send', session_id: sid.value, parent_id: session.value?.head_message_id ?? null, parts, ...model.value })
}
function onStop() {
  if (sid.value !== null) sync.send({ type: 'stop', session_id: sid.value })
}
function updateTitle(e: Event) {
  const title = (e.target as HTMLInputElement).value.trim()
  if (sid.value !== null && title) sync.send({ type: 'session.update', session_id: sid.value, title })
}
function updateSystemPrompt(e: Event) {
  const v = (e.target as HTMLTextAreaElement).value
  if (sid.value !== null) sync.send({ type: 'session.update', session_id: sid.value, system_prompt: v || null })
}
function onModelChange(value: ModelRef | null) {
  model.value = value
}
</script>

<template lang="pug">
.flex.h-full.flex-col
  .flex.items-center.gap-2.border-b.px-4.py-2(v-if="session")
    Input(:model-value="session.title" class="h-8 max-w-xs text-sm" @change="updateTitle")
    details.text-xs
      summary.cursor-pointer.text-muted-foreground 系统提示
      Textarea(:model-value="session.system_prompt ?? ''" rows="3" class="mt-2 w-80" placeholder="留空则不发送 system prompt" @change="updateSystemPrompt")
  .min-h-0.flex-1
    MessageList(v-if="path.length" :messages="path")
    .flex.h-full.items-center.justify-center.text-muted-foreground(v-else) 开始一段新对话
  Composer(:streaming="streaming" :connected="sync.status === 'open'" :model="model" @update:model="onModelChange" @send="onSend" @stop="onStop")
</template>
