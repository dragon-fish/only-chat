<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ExternalLinkIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/client/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Progress } from '@/client/ui/progress'
import { Spinner } from '@/client/ui/spinner'
import type { CodexOAuthStartResponse } from '@/shared/api'
import type { ProviderWithInterfaces } from '@/shared/models'

type ViewState =
  | { type: 'starting' }
  | { type: 'waiting'; grant: CodexOAuthStartResponse }
  | { type: 'failed'; message: string }
  | { type: 'expired' }

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean]; created: [ProviderWithInterfaces] }>()
const state = ref<ViewState>({ type: 'starting' })
const now = ref(Date.now())
const flowStartedAt = ref(0)
let pollTimer: ReturnType<typeof setTimeout> | undefined
let expiryTimer: ReturnType<typeof setTimeout> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined
let activeFlowId: string | undefined
let cancelledFlowId: string | undefined
let run = 0

const waitingGrant = computed(() => state.value.type === 'waiting' ? state.value.grant : undefined)
const secondsRemaining = computed(() => waitingGrant.value ? Math.max(0, Math.ceil((waitingGrant.value.expires_at - now.value) / 1_000)) : 0)
const timeProgress = computed(() => {
  const grant = waitingGrant.value
  if (!grant) return 0
  const total = Math.max(1, grant.expires_at - flowStartedAt.value)
  return Math.max(0, Math.min(100, ((grant.expires_at - now.value) / total) * 100))
})

function clearTimers() {
  if (pollTimer !== undefined) clearTimeout(pollTimer)
  if (expiryTimer !== undefined) clearTimeout(expiryTimer)
  if (clockTimer !== undefined) clearInterval(clockTimer)
  pollTimer = expiryTimer = clockTimer = undefined
}

function cancelActiveFlow() {
  const flowId = activeFlowId
  activeFlowId = undefined
  if (!flowId || cancelledFlowId === flowId) return
  cancelledFlowId = flowId
  void api.cancelCodexOAuth(flowId).catch(() => undefined)
}

function stop(cancel = false) {
  run++
  clearTimers()
  if (cancel) cancelActiveFlow()
  else activeFlowId = undefined
}

function expire(version: number) {
  if (version !== run || state.value.type !== 'waiting') return
  clearTimers()
  activeFlowId = undefined
  state.value = { type: 'expired' }
}

function schedulePoll(version: number, nextPollAt: number) {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(() => { void poll(version) }, Math.max(0, nextPollAt - Date.now()))
}

async function poll(version: number) {
  const grant = waitingGrant.value
  if (!grant || version !== run) return
  try {
    const result = await api.pollCodexOAuth(grant.flow_id)
    if (version !== run || state.value.type !== 'waiting') return
    if (result.status === 'pending') {
      schedulePoll(version, result.next_poll_at)
      return
    }
    clearTimers()
    activeFlowId = undefined
    if (result.status === 'complete') {
      if (result.model_sync_warning) toast.warning(result.model_sync_warning)
      emit('created', result.provider)
      emit('update:open', false)
      return
    }
    state.value = { type: 'failed', message: result.error }
  } catch (cause) {
    if (version !== run) return
    clearTimers()
    activeFlowId = undefined
    state.value = { type: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  }
}

async function start() {
  stop(false)
  const version = ++run
  state.value = { type: 'starting' }
  try {
    const grant = await api.startCodexOAuth()
    if (version !== run || !props.open) {
      void api.cancelCodexOAuth(grant.flow_id).catch(() => undefined)
      return
    }
    state.value = { type: 'waiting', grant }
    activeFlowId = grant.flow_id
    cancelledFlowId = undefined
    now.value = Date.now()
    flowStartedAt.value = now.value
    clockTimer = setInterval(() => { now.value = Date.now() }, 1_000)
    expiryTimer = setTimeout(() => expire(version), Math.max(0, grant.expires_at - Date.now()))
    schedulePoll(version, Date.now() + grant.poll_interval_ms)
  } catch (cause) {
    if (version !== run) return
    state.value = { type: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  }
}

function retry() { void start() }
function handleOpenChange(open: boolean) {
  if (!open) stop(true)
  emit('update:open', open)
}

watch(() => props.open, open => {
  if (open) void start()
  else stop(true)
}, { immediate: true })
onBeforeUnmount(() => stop(true))
</script>

<template lang="pug">
Dialog(:open="open" @update:open="handleOpenChange")
  DialogContent(class="sm:max-w-md")
    DialogHeader
      DialogTitle 连接 Codex
      DialogDescription 使用一次性设备代码授权你的 Codex 账户。此窗口不会显示或保存 API Key。
    .flex.flex-col.gap-5
      .flex.items-center.gap-2(v-if="state.type === 'starting'" role="status")
        Spinner
        span 正在创建设备代码…
      template(v-else-if="state.type === 'waiting'")
        FieldGroup(class="gap-4")
          Field
            FieldLabel 一次性代码
            code.rounded-md.border.bg-muted.px-3.py-2.text-center.text-lg.font-semibold.tracking-widest(data-codex-user-code) {{ state.grant.user_code }}
            FieldDescription 在打开的授权页面中输入这组代码。
          Field
            .flex.items-center.justify-between.gap-3
              FieldLabel 授权有效期
              span.text-sm.text-muted-foreground {{ secondsRemaining }} 秒
            Progress(:model-value="timeProgress")
        Button(as-child variant="outline")
          a(:href="state.grant.verification_url" target="_blank" rel="noreferrer")
            ExternalLinkIcon(data-icon="inline-start")
            | 打开授权页面
        p.text-sm.text-muted-foreground(role="status") 等待授权完成后将自动继续。
      template(v-else-if="state.type === 'expired'")
        p.text-sm.text-muted-foreground(data-codex-expired) 这组设备代码已过期。请重新开始以获取新的代码。
      template(v-else)
        p.text-sm.text-destructive(role="alert") {{ state.message }}
    DialogFooter(v-if="state.type === 'failed' || state.type === 'expired'")
      Button(type="button" @click="retry") 重试
</template>
