<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { CircleHelpIcon, GlobeIcon, RefreshCwIcon, XIcon } from '@lucide/vue'
import { pendingHumanCalls } from '@/client/components/tool-part-renderer'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { BROWSER_HANDOFF_TOOL_ID } from '@/shared/plugins'
import { BrowserHandoffInputSchema, LIVE_VIEW_REFRESH_MARGIN_MS, type BrowserHandoffResult, type BrowserProfile } from '../shared'
import { requestAttention, sendCommand, sessions } from './state'

const props = defineProps<{
  conversationId: number | null
  projectId: number | null
}>()
const sync = useSyncStore()

const state = computed(() => (props.conversationId === null ? undefined : sessions.get(props.conversationId)))
const active = computed(() => state.value?.status === 'active')
const liveViewUrl = computed(() => (active.value ? state.value?.live_view_url ?? null : null))

const PROFILE_LABELS: Record<BrowserProfile, string> = { ephemeral: '阅后即焚', project: '工作区共享', user: '用户级共享' }

// The server keeps nothing for a client that was not listening, so every mount asks.
watch(() => props.conversationId, (id) => {
  if (id !== null) sendCommand({ kind: 'state', conversation_id: id })
}, { immediate: true })

// A Live View link expires; ask for the next one before the current runs out, never after.
let refreshTimer: ReturnType<typeof setTimeout> | undefined
watch(() => state.value?.live_view_expires_at, (expiresAt) => {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  refreshTimer = undefined
  if (!expiresAt || props.conversationId === null || !active.value) return
  const delay = Math.max(1_000, expiresAt - LIVE_VIEW_REFRESH_MARGIN_MS - Date.now())
  const id = props.conversationId
  refreshTimer = setTimeout(() => sendCommand({ kind: 'refresh_live_view', conversation_id: id }), delay)
}, { immediate: true })
onBeforeUnmount(() => { if (refreshTimer !== undefined) clearTimeout(refreshTimer) })

const elapsed = ref('')
let elapsedTimer: ReturnType<typeof setInterval> | undefined
function tick() {
  const startedAt = state.value?.started_at
  if (!startedAt || !active.value) { elapsed.value = ''; return }
  const minutes = Math.floor((Date.now() - startedAt) / 60_000)
  elapsed.value = minutes < 1 ? '刚打开' : `已打开 ${minutes} 分钟`
}
watch(active, (on) => {
  if (elapsedTimer !== undefined) clearInterval(elapsedTimer)
  elapsedTimer = on ? setInterval(tick, 30_000) : undefined
  tick()
}, { immediate: true })
onBeforeUnmount(() => { if (elapsedTimer !== undefined) clearInterval(elapsedTimer) })

// The pending handoff, if any, is a tool call on the conversation head waiting for a person.
const handoff = computed(() => {
  if (props.conversationId === null) return null
  const conversation = sync.conversations.get(props.conversationId)
  const pending = pendingHumanCalls(sync.pathFor(props.conversationId), conversation?.head_message_id)
    .find(candidate => candidate.call.name === BROWSER_HANDOFF_TOOL_ID)
  if (!pending) return null
  const input = BrowserHandoffInputSchema.safeParse(pending.call.args)
  return { messageId: pending.messageId, callId: pending.call.id, instructions: input.success ? input.data.instructions : '（说明无法解析）' }
})
watch(() => handoff.value?.callId, (callId) => { if (callId) requestAttention({ force: true }) }, { immediate: true })

const busy = ref(false)
watch(() => handoff.value?.callId, () => { busy.value = false })
function finish(status: 'done' | 'failed') {
  const current = handoff.value
  if (!current) return
  const result: BrowserHandoffResult = { status }
  const requestId = crypto.randomUUID()
  sync.lastError = null
  sync.beginOptimistic(requestId, {
    kind: 'tool_result',
    messageId: current.messageId,
    part: { type: 'tool_result', call_id: current.callId, name: BROWSER_HANDOFF_TOOL_ID, content: result },
  })
  if (sync.status !== 'open' || !sync.send({ type: 'tool.respond', request_id: requestId, message_id: current.messageId, call_id: current.callId, result })) {
    sync.rejectOptimistic(requestId)
    sync.lastError = DISCONNECTED_MESSAGE
    return
  }
  busy.value = true
}

function closeBrowser() {
  if (props.conversationId !== null) sendCommand({ kind: 'close', conversation_id: props.conversationId })
}

/** The Live View frame cannot tell us it lost its tab; the person can, with one press. */
function refreshView() {
  if (props.conversationId !== null) sendCommand({ kind: 'refresh_live_view', conversation_id: props.conversationId })
}
</script>

<template lang="pug">
.flex.h-full.min-h-0.flex-col
  Alert(v-if="handoff" class="m-2 shrink-0 border-primary")
    CircleHelpIcon
    AlertTitle 模型请你接手
    AlertDescription
      p.whitespace-pre-wrap {{ handoff.instructions }}
      .mt-2.flex.gap-2
        Button(size="sm" class="min-h-9" :disabled="busy" @click="finish('done')") 完成
        Button(size="sm" variant="outline" class="min-h-9" :disabled="busy" @click="finish('failed')") 失败
  iframe.min-h-0.flex-1.border-0.bg-background(
    v-if="liveViewUrl" :src="liveViewUrl" title="实时浏览器" allow="clipboard-read; clipboard-write")
  Empty(v-else-if="active" class="min-h-0 flex-1")
    EmptyHeader
      EmptyTitle 正在准备实时画面
      EmptyDescription 浏览器已经打开，画面链接马上就来。
  Empty(v-else class="min-h-0 flex-1")
    EmptyHeader
      EmptyTitle 浏览器还没打开
      EmptyDescription 模型第一次调用 browser_use 时会在这里显示它看到的页面，你可以随时伸手操作。
  .flex.shrink-0.items-center.gap-2.border-t.px-3.py-1.text-xs.text-muted-foreground(v-if="active")
    GlobeIcon(class="size-3.5 shrink-0")
    span {{ elapsed }}
    Badge(v-if="state?.profile" variant="secondary") {{ PROFILE_LABELS[state.profile] }}
    Button(variant="ghost" size="sm" class="ml-auto h-7 px-2" title="重新获取实时画面" @click="refreshView")
      RefreshCwIcon(data-icon="inline-start")
      | 刷新画面
    Button(variant="ghost" size="sm" class="h-7 px-2" title="关闭浏览器" @click="closeBrowser")
      XIcon(data-icon="inline-start")
      | 关闭浏览器
</template>
