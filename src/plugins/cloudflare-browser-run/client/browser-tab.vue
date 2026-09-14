<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CircleHelpIcon, GlobeIcon, PauseIcon, PlayIcon, RefreshCwIcon, XIcon } from '@lucide/vue'
import { pendingHumanCalls } from '@/client/components/tool-part-renderer'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { BROWSER_HANDOFF_TOOL_ID } from '@/shared/plugins'
import {
  BrowserHandoffInputSchema, LIVE_VIEW_IDLE_MS, LIVE_VIEW_REFRESH_MARGIN_MS,
  type BrowserHandoffResult, type BrowserProfile,
} from '../shared'
import { formatCountdown, liveViewPhase } from './live-view-idle'
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
const IDLE_MINUTES = Math.round(LIVE_VIEW_IDLE_MS / 60_000)

// The server keeps nothing for a client that was not listening, so every mount asks.
watch(() => props.conversationId, (id) => {
  if (id !== null) sendCommand({ kind: 'state', conversation_id: id })
}, { immediate: true })

// ---- idle: the frame is a connected client, and a connected client keeps the session billing.
const now = ref(Date.now())
const lastActivityAt = ref(Date.now())
const pageHidden = ref(typeof document !== 'undefined' && document.visibilityState === 'hidden')
const frame = ref<HTMLIFrameElement | null>(null)
const phase = computed(() => liveViewPhase({ hidden: pageHidden.value, lastActivityAt: lastActivityAt.value, now: now.value, idleMs: LIVE_VIEW_IDLE_MS }))
const showFrame = computed(() => liveViewUrl.value !== null && phase.value === 'shown')
const countdown = computed(() => formatCountdown(lastActivityAt.value + LIVE_VIEW_IDLE_MS - now.value))

function touch() { lastActivityAt.value = Date.now() }
// A session event means the model or another device just used the browser.
watch(state, touch)

// The frame is cross-origin, so what happens inside it is invisible. What does reach us: focus
// entering it (the window blurs) and the pointer crossing its edge. Each counts once, never as a
// standing state — focus left resting on the frame by someone who walked away must still idle out.
function onWindowBlur() {
  if (frame.value && document.activeElement === frame.value) touch()
}
onMounted(() => window.addEventListener('blur', onWindowBlur))
onBeforeUnmount(() => window.removeEventListener('blur', onWindowBlur))

function tick() { now.value = Date.now() }
let ticker: ReturnType<typeof setInterval> | undefined
watch(active, (on) => {
  if (ticker !== undefined) clearInterval(ticker)
  ticker = on ? setInterval(tick, 1_000) : undefined
  tick()
}, { immediate: true })
onBeforeUnmount(() => { if (ticker !== undefined) clearInterval(ticker) })

/** Coming back after a pause: the session may be gone, and the link may be stale; `state` settles both. */
function resume() {
  touch()
  if (props.conversationId !== null) sendCommand({ kind: 'state', conversation_id: props.conversationId })
}
function onVisibilityChange() {
  pageHidden.value = document.visibilityState === 'hidden'
  if (!pageHidden.value && active.value && phase.value === 'shown') resume()
}
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisibilityChange))

// A Live View link expires; ask for the next one before the current runs out, never after. A
// paused frame gets its link on resume instead.
let refreshTimer: ReturnType<typeof setTimeout> | undefined
watch([() => state.value?.live_view_expires_at, showFrame], ([expiresAt, shown]) => {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  refreshTimer = undefined
  if (!expiresAt || !shown || props.conversationId === null) return
  const delay = Math.max(1_000, expiresAt - LIVE_VIEW_REFRESH_MARGIN_MS - Date.now())
  const id = props.conversationId
  refreshTimer = setTimeout(() => sendCommand({ kind: 'refresh_live_view', conversation_id: id }), delay)
}, { immediate: true })
onBeforeUnmount(() => { if (refreshTimer !== undefined) clearTimeout(refreshTimer) })

const elapsed = computed(() => {
  const startedAt = state.value?.started_at
  if (!startedAt || !active.value) return ''
  const minutes = Math.floor((now.value - startedAt) / 60_000)
  return minutes < 1 ? '刚打开' : `已打开 ${minutes} 分钟`
})

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
.flex.h-full.min-h-0.flex-col(@pointerdown.capture="touch" @keydown.capture="touch")
  Alert(v-if="handoff" class="m-2 shrink-0 border-primary")
    CircleHelpIcon
    AlertTitle 模型请你接手
    AlertDescription
      p.whitespace-pre-wrap {{ handoff.instructions }}
      .mt-2.flex.gap-2
        Button(size="sm" class="min-h-9" :disabled="busy" @click="finish('done')") 完成
        Button(size="sm" variant="outline" class="min-h-9" :disabled="busy" @click="finish('failed')") 失败
  iframe.min-h-0.flex-1.border-0.bg-background(
    v-if="showFrame" ref="frame" :src="liveViewUrl ?? undefined" title="实时浏览器" allow="clipboard-read; clipboard-write"
    @pointerenter="touch" @pointerleave="touch")
  Empty(v-else-if="active && liveViewUrl" class="min-h-0 flex-1")
    EmptyHeader
      PauseIcon(class="size-6 text-muted-foreground")
      EmptyTitle 画面已暂停
      EmptyDescription 超过 {{ IDLE_MINUTES }} 分钟没有操作，画面已断开；浏览器本身没人用满 {{ IDLE_MINUTES }} 分钟后会被平台回收。
      Button(size="sm" class="mt-2 min-h-9" @click="resume")
        PlayIcon(data-icon="inline-start")
        | 恢复画面
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
    span.tabular-nums(v-if="showFrame" :title="`${IDLE_MINUTES} 分钟没有操作就暂停画面，好让平台回收闲置的浏览器`") 闲置 {{ countdown }} 后暂停
    Button(variant="ghost" size="sm" class="ml-auto h-7 px-2" title="重新获取实时画面" @click="refreshView")
      RefreshCwIcon(data-icon="inline-start")
      | 刷新画面
    Button(variant="ghost" size="sm" class="h-7 px-2" title="关闭浏览器" @click="closeBrowser")
      XIcon(data-icon="inline-start")
      | 关闭浏览器
</template>
