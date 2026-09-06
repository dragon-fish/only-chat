<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, RotateCcw, Zap } from '@lucide/vue'
import { REASONING_LABELS, type ReasoningChoice, type ReasoningStop } from '@/client/stores/sync'

const props = withDefaults(defineProps<{
  /** What this layer stores. `inherit` writes nothing and falls through to `inherited`. */
  modelValue: ReasoningChoice
  /** The stops this model's declared capabilities allow, weakest first. Empty hides the track. */
  stops: ReasoningStop[]
  /** Shown under the level, so it is always clear whose capabilities produced the stops. */
  modelName?: string | null
  /** What `inherit` resolves to below this layer; `inherit` again means "the model decides". */
  inherited?: ReasoningChoice
  /** 继承自 Project / 会话覆盖 — the parent decides the wording (spec §7.3). */
  sourceLabel?: string | null
  /** Whether restoring inheritance is meaningful here. */
  canReset?: boolean
}>(), { modelName: null, inherited: 'inherit', sourceLabel: null, canReset: false })

const emit = defineEmits<{ 'update:modelValue': [ReasoningChoice] }>()

/** What the track points at: this layer's own choice, or the value it inherits. */
const active = computed<ReasoningChoice>(() => props.modelValue === 'inherit' ? props.inherited : props.modelValue)
const index = computed(() => props.stops.findIndex((s) => s === active.value))
/** A stored level the current model never declared is shown as-is rather than silently rewritten. */
const unsupported = computed(() => active.value !== 'inherit' && index.value < 0)

const label = computed(() => {
  // Until the model is resolved (the config loads after the first paint) nothing is known about
  // its capabilities, so the pill says so instead of claiming the model cannot reason.
  if (!props.stops.length) return props.modelName ? '不支持推理' : '未选择模型'
  if (active.value === 'inherit') return '默认'
  const name = REASONING_LABELS[active.value]
  return unsupported.value ? `${name}（不适用）` : name
})

const tone = computed(() => {
  if (index.value < 0) return { text: 'text-muted-foreground', fill: 'bg-muted-foreground/40' }
  if (active.value === 'off') return { text: 'text-muted-foreground', fill: 'bg-zinc-400' }
  if (index.value === props.stops.length - 1 && props.stops.length > 2) {
    return { text: 'text-purple-500', fill: 'bg-gradient-to-r from-blue-500 to-purple-500' }
  }
  return { text: 'text-blue-500', fill: 'bg-blue-500' }
})

const fill = computed(() => index.value < 0 ? '0%' : percent(index.value))

/** A lone stop sits in the middle of the track: pinning it to the right edge would read as a
 *  maxed-out level rather than as the only level this model offers. */
function percent(i: number): string {
  return props.stops.length < 2 ? '50%' : `${(i / (props.stops.length - 1)) * 100}%`
}
function labelOf(stop: ReasoningStop): string {
  return REASONING_LABELS[stop]
}
/** The centred label doubles as a "next level" control, matching the chevron beside it. */
function cycle() {
  if (!props.stops.length) return
  emit('update:modelValue', props.stops[(index.value + 1) % props.stops.length]!)
}
</script>

<template lang="pug">
.flex.flex-col.gap-1.rounded-xl.border.px-3.py-2(class="bg-card")
  .flex.items-center.gap-2
    Zap(class="size-3.5 shrink-0" :class="tone.text")
    button.flex.min-w-0.flex-1.items-center.justify-center.gap-1.text-sm.font-medium(
      type="button" :class="tone.text" :aria-disabled="!stops.length" @click="cycle")
      span.truncate {{ label }}
      ChevronRight(v-if="stops.length" class="size-3.5 shrink-0 opacity-60")
    button.shrink-0.text-muted-foreground(
      v-if="canReset" type="button" title="恢复继承" class="hover:text-foreground"
      @click="emit('update:modelValue', 'inherit')")
      RotateCcw(class="size-3.5")
    span.shrink-0(v-else class="size-3.5")
  p.truncate.text-center.text-xs.text-muted-foreground(v-if="modelName") {{ modelName }}
  p.text-center.text-xs.text-muted-foreground(v-if="sourceLabel") {{ sourceLabel }}
  .relative.h-5(v-if="stops.length")
    .absolute.h-1.rounded-full(class="left-0 right-0 top-2 bg-muted")
    .absolute.h-1.rounded-full(class="left-0 top-2" :class="tone.fill" :style="{ width: fill }")
    button.absolute.flex.items-center.justify-center(
      v-for="(s, i) in stops" :key="s" type="button"
      class="top-0 h-5 w-5 -translate-x-1/2" :style="{ left: percent(i) }"
      :title="labelOf(s)" :aria-label="labelOf(s)" @click="emit('update:modelValue', s)")
      span.rounded-full(:class="i === index ? 'size-4 bg-white shadow ring-1 ring-black/10' : 'size-1.5 bg-muted-foreground/50'")
</template>
