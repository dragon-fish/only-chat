<script setup lang="ts">
import { computed, inject, provide, ref } from 'vue'
import { ChevronRightIcon, TriangleAlertIcon } from '@lucide/vue'
import { provideFormName, Renderer, type ActionEvent } from '@openuidev/vue-lang'
import { USER_MESSAGE_SENDER } from '@/client/lib/user-message-sender'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { RenderUiInputSchema, RenderUiResultSchema } from '../shared'
import { clientLibrary } from './library'
import { messageFromAction } from './message'
import { GENERATIVE_UI_HOST } from './runtime'

const props = defineProps<{
  call: ToolCallPart
  result: ToolResultPart | null
  canContinue?: boolean
  busy?: boolean
}>()

const sender = inject(USER_MESSAGE_SENDER, null)
const code = computed(() => RenderUiInputSchema.safeParse(props.call.args).data?.code ?? null)
const outcome = computed(() => RenderUiResultSchema.safeParse(props.result?.content).data ?? null)
const canMessage = computed(() => sender !== null && sender.available && !props.busy)
provide(GENERATIVE_UI_HOST, { canMessage })
// vue-lang injects the form name without a default and warns for every control outside a Form.
provideFormName(ref(undefined))

function onAction(event: ActionEvent) {
  if (event.type === 'open_url') {
    const url = event.params.url
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener')
    return
  }
  if (event.type === 'continue_conversation' && canMessage.value) sender?.send(messageFromAction(event))
}
</script>

<template lang="pug">
//- A program the server rejected was never meant to be seen; the model gets the errors and retries.
details.text-muted-foreground.text-sm(v-if="outcome?.status === 'invalid'" class="group")
  summary.oc-turn-row.cursor-pointer.list-none
    TriangleAlertIcon(class="size-4 shrink-0")
    span 交互卡片有误，已退回模型修改
    ChevronRightIcon(class="size-3.5 shrink-0 transition-transform group-open:rotate-90")
  ul.mt-1.list-disc.pl-6.text-xs
    li(v-for="(error, index) in outcome.errors" :key="index") {{ error }}
.my-2.w-full.min-w-0(v-else-if="code")
  Renderer(:response="code" :library="clientLibrary" :is-streaming="false" :on-action="onAction")
</template>
