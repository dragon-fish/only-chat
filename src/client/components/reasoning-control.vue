<script setup lang="ts">
import { computed, ref } from 'vue'
import { Brain } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
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
  /** True when the session overrides its Project, which is what surfaces the 默认 button. */
  overridden: boolean
  /** No model resolved yet — a different disabled reason from "this model cannot reason". */
  noModel: boolean
}>(), { capabilities: null, protocol: null, stops: null })
const emit = defineEmits<{ update: [choice: ReasoningChoice] }>()

const stops = computed(() => props.stops ?? (props.capabilities && props.protocol
  ? reasoningStopsFor(props.capabilities, props.protocol)
  : []))
const model = computed(() => reasoningControlModel(stops.value, props.active))

/** Spec §5.1: a control that cannot act says why; it never silently disappears. */
const disabledReason = computed(() => {
  if (props.noModel) return '先选择模型'
  // A model that cannot reason yields NO stops at all. Do NOT test `model.unsupported` here:
  // that flag means "a strength is stored that this model does not offer", and it is false for a
  // non-reasoning model, so using it would leave the chip enabled on exactly the model it is
  // meant to disable for.
  if (stops.value.length === 0) return '该模型不支持推理'
  return null
})

const chipLabel = computed(() => {
  if (!model.value.enabled) return REASONING_LABELS.off
  // `inherit` reaching here is the same request as `auto` (see `reasoningControlModel`); testing it
  // explicitly is also what narrows `props.active` to a real stop for the line below.
  if (model.value.auto || props.active === 'inherit') return REASONING_LABELS.auto
  // Spec §5.5: a stored strength this model does not offer is shown as-is, never rewritten.
  // Reading `props.active` rather than indexing `strengths` is what preserves that — `index` is
  // -1 in that case, and a fallback like `?? 'medium'` would silently claim the wrong stop.
  return REASONING_LABELS[props.active]
})

/**
 * The chip is `aria-disabled`, never `disabled`: `InputGroup` carries `has-disabled:opacity-50`,
 * which compiles to `:has(*:disabled)` and would grey the entire Composer card around it. So the
 * popover is opened through a guarded handler rather than by the trigger alone.
 */
const open = ref(false)
function setOpen(next: boolean) {
  if (next && disabledReason.value !== null) return
  open.value = next
}

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
  <Popover :open="open" @update:open="setOpen">
    <PopoverTrigger as-child>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        class="gap-1.5 aria-disabled:opacity-50"
        :aria-disabled="disabledReason !== null"
        :title="disabledReason ?? '思考强度'"
      >
        <Brain data-icon="inline-start" />
        <span class="text-xs">{{ chipLabel }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80">
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
        <div class="text-muted-foreground mt-2 flex justify-between text-[11px]">
          <span
            v-for="(stop, i) in model.strengths"
            :key="stop"
            :class="cn(
              !model.enabled || model.auto ? 'opacity-40' : '',
              i === model.index && model.enabled && !model.auto ? 'text-foreground font-medium' : '',
            )"
          >{{ REASONING_LABELS[stop] }}</span>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
