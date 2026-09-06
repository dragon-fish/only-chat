<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/client/ui/button'
import { Separator } from '@/client/ui/separator'
import { Slider } from '@/client/ui/slider'
import { Switch } from '@/client/ui/switch'
import { cn } from '@/client/lib/utils'
import {
  REASONING_LABELS,
  reasoningChoiceFor,
  reasoningControlModel,
  reasoningStopsFor,
} from '@/client/stores/sync'
import type { ReasoningAction, ReasoningChoice, ReasoningStop } from '@/client/stores/sync'
import type { ModelCapabilities, Protocol } from '@/shared/models'

/**
 * The three reasoning controls themselves: the 思考 switch, the 自动 switch and the strength
 * slider. Rendered inline wherever there is room for them — a settings form — and wrapped in a chip
 * and a popover by `reasoning-control.vue` where there is not, which is the Composer's toolbar.
 *
 * A caller supplies the axis one of two ways: the resolved model's declarations, which is what the
 * chat page has, or a ready-made `stops` list, which is what the Project page needs — a Project
 * with no default model constrains nothing, so its axis cannot be derived from a model at all.
 */
const props = withDefaults(defineProps<{
  capabilities?: ModelCapabilities | null
  protocol?: Protocol | null
  stops?: ReasoningStop[] | null
  /** The effective choice, already resolved through Project inheritance by the parent. */
  active: ReasoningChoice
  /** True when this layer overrides the one above it, which is what surfaces the 默认 button. */
  overridden: boolean
}>(), { capabilities: null, protocol: null, stops: null })
const emit = defineEmits<{ update: [choice: ReasoningChoice] }>()

const stops = computed(() => props.stops ?? (props.capabilities && props.protocol
  ? reasoningStopsFor(props.capabilities, props.protocol)
  : []))
const model = computed(() => reasoningControlModel(stops.value, props.active))

function act(action: ReasoningAction) {
  emit('update', reasoningChoiceFor(model.value, action))
}

/**
 * Where the thumb parks when no strength is pinned (自动 or 关闭). It is the same midpoint
 * `reasoningChoiceFor` lands on when 自动 is switched off, so the greyed thumb sits exactly where
 * leaving 自动 would put it. The selected *state* is still not shown — no label is highlighted and
 * the whole slider is dimmed — which is what spec §5.4 asks for.
 */
const parked = computed(() => Math.floor((model.value.strengths.length - 1) / 2))

/**
 * Where stop `i`'s tick centre actually sits along the track. Not `i / (n - 1)` of the full width:
 * reka insets the thumb, so its centre travels from `thumbW / 2` to `100% - thumbW / 2`. The thumb
 * is `size-5`, hence 20px. Labels laid out with `justify-between` instead distribute by their own
 * differing widths (极低 vs Max vs Ultra), which drifts the middle ones off their ticks.
 */
function stopOffset(i: number, count: number): string {
  const p = count > 1 ? i / (count - 1) : 0.5
  return `calc(10px + (100% - 20px) * ${p})`
}

/** reka-ui's Slider is multi-thumb, so it models its value as an array. */
const sliderValue = computed({
  get: () => [model.value.index < 0 ? parked.value : model.value.index],
  set: (value: number[]) => {
    const i = value[0]
    const stop = i === undefined ? undefined : model.value.strengths[i]
    if (stop) act({ kind: 'strength', stop })
  },
})

/**
 * Spec §5.4 wants the slider greyed while 自动 is on but still live, because pressing a stop is how
 * you leave 自动. reka only emits when the value actually changes, so pressing the stop the parked
 * thumb already sits on would otherwise be a dead click; leaving 自动 here on the first press makes
 * every stop live, and reka's own slide handling then writes whichever stop the pointer landed on.
 */
function onSliderPointerDown() {
  if (model.value.enabled && model.value.auto) act({ kind: 'auto', on: false })
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium">思考</span>
        <Switch
          :model-value="model.enabled"
          :disabled="!model.canDisable"
          :title="model.canDisable ? undefined : '该模型无法关闭思考'"
          @update:model-value="(on: boolean) => act({ kind: 'enable', on })"
        />
      </div>
      <Button v-if="overridden" variant="ghost" size="xs" type="button" @click="emit('update', 'inherit')">
        默认
      </Button>
    </div>

    <Separator />

    <div class="flex items-center gap-2">
      <span class="text-sm">自动</span>
      <Switch
        :model-value="model.auto"
        :disabled="!model.enabled"
        @update:model-value="(on: boolean) => act({ kind: 'auto', on })"
      />
    </div>

    <div class="mt-1">
      <Slider
        v-model="sliderValue"
        :min="0"
        :max="Math.max(model.strengths.length - 1, 0)"
        :step="1"
        :disabled="!model.enabled"
        :class="cn(
          '[&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-thumb]]:shadow [&_[data-slot=slider-track]]:h-1.5',
          model.auto && model.enabled ? 'opacity-50' : '',
        )"
        @pointerdown="onSliderPointerDown"
      />
      <div class="text-muted-foreground relative mt-2 h-4 text-[11px]">
        <span
          v-for="(stop, i) in model.strengths"
          :key="stop"
          class="absolute -translate-x-1/2 whitespace-nowrap"
          :style="{ left: stopOffset(i, model.strengths.length) }"
          :class="cn(
            !model.enabled || model.auto ? 'opacity-40' : '',
            i === model.index && model.enabled && !model.auto ? 'text-foreground font-medium' : '',
          )"
        >{{ REASONING_LABELS[stop] }}</span>
      </div>
    </div>
  </div>
</template>
