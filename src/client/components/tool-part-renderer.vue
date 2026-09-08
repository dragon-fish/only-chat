<script setup lang="ts">
import { inject, shallowRef, watch } from 'vue'
import { BracesIcon } from '@lucide/vue'
import type { Component } from 'vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Skeleton } from '@/client/ui/skeleton'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { AskUserResult } from '@/plugins/ask-user/shared'

const props = defineProps<{
  messageId: number
  call: ToolCallPart
  result: ToolResultPart | null
  canContinue: boolean
}>()
const sync = useSyncStore()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const renderer = shallowRef<Component | null>(null)
const loading = shallowRef(false)
const busy = shallowRef(false)

watch(() => props.call.name, async (name) => {
  renderer.value = null
  if (!host) return
  loading.value = true
  try { renderer.value = (await host.ensureToolRenderer(name) ?? null) as Component | null }
  catch { renderer.value = null }
  finally { loading.value = false }
}, { immediate: true })
watch(() => props.result, result => { if (result) busy.value = false })
watch(() => sync.lastError, error => { if (error) busy.value = false })

function send(command: Parameters<typeof sync.send>[0]) {
  sync.lastError = null
  if (sync.status !== 'open' || !sync.send(command)) {
    sync.lastError = DISCONNECTED_MESSAGE
    busy.value = false
    return
  }
  busy.value = true
}

function respond(result: AskUserResult) {
  send({ type: 'tool.respond', request_id: crypto.randomUUID(), message_id: props.messageId, call_id: props.call.id, result })
}

function continueGeneration() {
  send({ type: 'tool.continue', request_id: crypto.randomUUID(), message_id: props.messageId })
}
</script>

<template lang="pug">
.flex.flex-col.gap-2(v-if="loading")
  Skeleton(class="h-5 w-36")
  Skeleton(class="h-20 w-full")
component(
  v-else-if="renderer" :is="renderer" :call="call" :result="result"
  :can-continue="canContinue" :busy="busy" @respond="respond" @continue="continueGeneration")
Alert(v-else)
  BracesIcon
  AlertTitle {{ call.name }}
  AlertDescription {{ result ? '工具调用已完成' : '等待工具结果' }}
</template>
