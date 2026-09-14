<script setup lang="ts">
import { computed, inject, shallowRef, watch } from 'vue'
import { BracesIcon, CircleHelpIcon } from '@lucide/vue'
import type { Component } from 'vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { humanToolDescriptor } from '@/shared/plugins'
import { pluginManifests } from '@/shared/plugin-manifests'

const props = defineProps<{
  messageId: number
  call: ToolCallPart
  result: ToolResultPart | null
  canContinue: boolean
  placement?: 'message' | 'composer'
  deferPending?: boolean
  inputPending?: boolean
}>()
const sync = useSyncStore()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const renderer = shallowRef<Component | null>(null)
const loading = shallowRef(false)
const busy = shallowRef(false)
const optimisticResult = computed(() => sync.optimisticToolResult(props.messageId, props.call.id))
const effectiveResult = computed(() => props.result ?? optimisticResult.value ?? null)
/** A tool a person answers, by the manifests; nothing needs to be loaded to know. */
const human = computed(() => humanToolDescriptor(pluginManifests, props.call.name))
const inputPendingLabel = computed(() => human.value
  ? `正在准备${human.value.name}…`
  : `正在调用 ${props.call.name}`)
const compactPending = computed(() => (
  props.placement !== 'composer'
  && props.deferPending === true
  && effectiveResult.value === null
  && human.value !== undefined
))

watch(() => props.call.name, async (name) => {
  renderer.value = null
  if (!host) return
  loading.value = true
  try { renderer.value = (await host.ensureToolRenderer(name) ?? null) as Component | null }
  catch { renderer.value = null }
  finally { loading.value = false }
}, { immediate: true })
// A model can emit several ask_user calls in one turn; the Composer renders them one at a time and
// reuses this instance. The in-flight flag belongs to the call that was answered — carried over, it
// would disable the next call's card with nothing left to clear it.
watch(() => props.call.id, () => { busy.value = false })
watch(effectiveResult, result => { if (result) busy.value = false })
watch(() => sync.lastError, error => { if (error) busy.value = false })

function send(command: Parameters<typeof sync.send>[0], optimisticRequestId?: string) {
  sync.lastError = null
  if (sync.status !== 'open' || !sync.send(command)) {
    if (optimisticRequestId) sync.rejectOptimistic(optimisticRequestId)
    sync.lastError = DISCONNECTED_MESSAGE
    busy.value = false
    return
  }
  busy.value = true
}

function respond(result: unknown) {
  const requestId = crypto.randomUUID()
  sync.beginOptimistic(requestId, {
    kind: 'tool_result',
    messageId: props.messageId,
    part: { type: 'tool_result', call_id: props.call.id, name: props.call.name, content: result },
  })
  send({ type: 'tool.respond', request_id: requestId, message_id: props.messageId, call_id: props.call.id, result }, requestId)
}

function continueGeneration() {
  send({ type: 'tool.continue', request_id: crypto.randomUUID(), message_id: props.messageId })
}
</script>

<template lang="pug">
//- Every in-flight tool reads the same: a spinner and one line, exactly one row tall. The row is
//- the SHORTEST a tool card ever gets, never the tallest — the turn is anchored above, so growth
//- below is invisible while a shrink yanks the reply upward. Tall skeletons collapsing to a single
//- line is what made a run of tool calls jitter. On completion the spinner becomes the tool's icon.
.oc-turn-row.text-sm.text-muted-foreground(v-if="inputPending")
  Spinner(class="size-4 shrink-0")
  span {{ inputPendingLabel }}
Alert(v-else-if="compactPending")
  CircleHelpIcon
  AlertTitle 正在等待你的回答
  AlertDescription 请在下方回答问题后继续。
.oc-turn-row.text-sm.text-muted-foreground(v-else-if="loading")
  Spinner(class="size-4 shrink-0")
  span 正在调用 {{ call.name }}
.w-full(
  v-else-if="renderer" :data-optimistic="optimisticResult ? '' : undefined"
  :class="optimisticResult ? 'opacity-70' : undefined")
  component(
    :is="renderer" :call="call" :result="effectiveResult"
    :can-continue="canContinue" :busy="busy" @respond="respond" @continue="continueGeneration")
Alert(v-else)
  BracesIcon
  AlertTitle {{ call.name }}
  AlertDescription {{ effectiveResult ? '调用完成' : `正在调用 ${call.name}` }}
</template>
