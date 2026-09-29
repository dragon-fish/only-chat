<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { BrainIcon, ChevronRightIcon } from '@lucide/vue'
import { Spinner } from '@/client/ui/spinner'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'

const props = defineProps<{
  text: string
  /** The live tail of a streaming reply. Open while it is, collapsed the moment anything follows. */
  active: boolean
  /** Stamped server-side when the block closed; null while it is still open, or for older parts. */
  durationMs: number | null
  /** Reported reasoning tokens, when they can be pinned on this block. */
  tokens: number | null
}>()

// Follows `active` until the reader touches it; after that their choice wins for this block.
const overridden = ref(false)
const open = ref(props.active)
watch(() => props.active, value => { if (!overridden.value) open.value = value })

function setOpen(value: boolean) {
  overridden.value = true
  open.value = value
}

/**
 * A live count for the block being written, because the server's figure only arrives once it
 * closes. It starts when this component first goes active rather than when the model did, so it
 * can read a touch short — a settled block always shows the server's number instead.
 */
const elapsed = ref(0)
let startedAt: number | null = null
let ticker: ReturnType<typeof setInterval> | undefined

watch(() => props.active, (value) => {
  clearInterval(ticker)
  ticker = undefined
  if (!value) return
  startedAt ??= Date.now()
  elapsed.value = Date.now() - startedAt
  ticker = setInterval(() => { elapsed.value = Date.now() - (startedAt ?? Date.now()) }, 200)
}, { immediate: true })

onBeforeUnmount(() => clearInterval(ticker))

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000))

const label = computed(() => (props.active ? '正在思考' : '已思考'))

/**
 * Absent, not zero, when nothing was measured — a reply persisted before durations were recorded
 * has no honest figure to show, and rendering one anyway is how 「用时 NaN 秒」 happens.
 */
const timing = computed(() => {
  if (props.active) return `${seconds(elapsed.value)} 秒`
  const parts: string[] = []
  if (props.durationMs !== null && Number.isFinite(props.durationMs)) {
    const whole = seconds(props.durationMs)
    if (whole > 0) parts.push(`用时 ${whole} 秒`)
  }
  if (props.tokens !== null) parts.push(`${props.tokens.toLocaleString()} tokens`)
  return parts.length > 0 ? parts.join(' · ') : null
})

/** The provider hid the thinking itself; the row only says it happened and has nothing to open. */
const hidden = computed(() => props.text === '')

const preview = computed(() => props.text.replace(/\s+/g, ' ').trim())
</script>

<template lang="pug">
.oc-turn-row.text-xs.text-muted-foreground(v-if="hidden")
  component(:is="active ? Spinner : BrainIcon" class="size-4 shrink-0")
  span.shrink-0 {{ label }}
  span.shrink-0(v-if="timing" class="opacity-70") （{{ timing }}）
Collapsible(v-else :open="open" @update:open="setOpen")
  CollapsibleTrigger(
    class="oc-turn-row group text-xs text-muted-foreground hover:bg-accent hover:text-foreground")
    //- Spinning while it runs, the brain once it has stopped — the same reading a tool card gives.
    component(:is="active ? Spinner : BrainIcon" class="size-4 shrink-0")
    span.shrink-0 {{ label }}
    span.shrink-0(v-if="timing" class="opacity-70") （{{ timing }}）
    //- The one-line peek is what makes a collapsed block worth leaving collapsed.
    span(v-if="!open" class="min-w-0 flex-1 truncate text-left opacity-60") {{ preview }}
    ChevronRightIcon(class="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90")
  CollapsibleContent
    .oc-scroll.mt-1.max-h-80.overflow-y-auto.border-l.pl-3(class="text-xs leading-relaxed text-muted-foreground")
      p.whitespace-pre-wrap {{ text }}
</template>
