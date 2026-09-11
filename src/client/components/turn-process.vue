<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { NodeRendererProps } from 'markstream-vue'
import { BrainIcon, ChevronRightIcon } from '@lucide/vue'
import TurnSegments from '@/client/components/turn-segments.vue'
import { totalReasoningMs, type MessageSegment } from '@/client/components/message-segments'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'

const props = defineProps<{
  segments: readonly MessageSegment[]
  messageId: number
  streaming: boolean
  activeSegmentKey: string | null
  canContinueTools: boolean
  isConversationHead: boolean
  isDark: boolean
  codeBlockProps: NonNullable<NodeRendererProps['codeBlockProps']>
}>()

// Runs holding an unanswered tool are never grouped, so this only ever wraps settled steps.
const live = computed(() => props.streaming && props.activeSegmentKey !== null
  && props.segments.some(segment => segment.key === props.activeSegmentKey))

const overridden = ref(false)
const open = ref(live.value)
watch(live, (isLive) => { if (!overridden.value) open.value = isLive })

function setOpen(value: boolean) {
  overridden.value = true
  open.value = value
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000))

/** Live ticking belongs to the individual block; the summary only reports a settled total. */
const totalMs = computed(() => totalReasoningMs(props.segments))

/**
 * A group holds thinking and tool calls, so it is named for the whole rather than for one half.
 * Calling it 「已思考」 put that label immediately above the identical label on each block inside.
 */
const label = computed(() => {
  if (!live.value) return '执行过程'
  const active = props.segments.find(segment => segment.key === props.activeSegmentKey)
  return active?.kind === 'tool' ? `正在调用 ${active.call.name}` : '正在思考'
})

const timing = computed(() => {
  if (live.value || totalMs.value === null || !Number.isFinite(totalMs.value)) return null
  // 「用时 0 秒」 is noise, and a tool that answers instantly produces a lot of it.
  const whole = seconds(totalMs.value)
  return whole > 0 ? `共 ${whole} 秒` : null
})

const steps = computed(() => props.segments.filter(segment => segment.kind === 'tool').length)
</script>

<template lang="pug">
Collapsible(:open="open" @update:open="setOpen")
  CollapsibleTrigger(
    class="oc-turn-row group text-xs text-muted-foreground hover:bg-accent hover:text-foreground")
    BrainIcon(class="size-4 shrink-0")
    span.shrink-0 {{ label }}
    span.shrink-0(v-if="timing" class="opacity-70") （{{ timing }}）
    span.shrink-0(v-if="steps" class="opacity-70") · {{ steps }} 次工具调用
    ChevronRightIcon(class="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90")
  CollapsibleContent
    .mt-2.border-l.pl-3
      TurnSegments(
        :segments="segments" :message-id="messageId" :streaming="streaming"
        :active-segment-key="activeSegmentKey" :can-continue-tools="canContinueTools"
        :is-conversation-head="isConversationHead" :is-dark="isDark"
        :code-block-props="codeBlockProps")
</template>
