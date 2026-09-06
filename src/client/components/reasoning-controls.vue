<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/client/ui/button'
import { Separator } from '@/client/ui/separator'
import { Slider } from '@/client/ui/slider'
import { Switch } from '@/client/ui/switch'
import { Toggle } from '@/client/ui/toggle'
import { cn } from '@/client/lib/utils'
import {
  REASONING_LABELS,
  reasoningChoiceFor,
  reasoningControlModel,
  reasoningDisabledReason,
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

/**
 * Spec §5.1: a control that cannot act says why, here and not only in the chip. The chip guards
 * the Composer, but this body is rendered directly by the Project settings page, and without the
 * reason that page showed three live-looking widgets for a model that cannot reason at all.
 * The chip adds its own extra case (no model resolved yet) on top of this one.
 */
const disabledReason = computed(() => reasoningDisabledReason(stops.value))

/**
 * Where the thumb parks when no strength is pinned (自动, 关闭, or a stored strength this model
 * does not offer). It is the same midpoint `reasoningChoiceFor` lands on when 自动 is switched off,
 * so the greyed thumb sits exactly where leaving 自动 would put it. The selected *state* is still
 * not shown — no label is highlighted and the whole slider is dimmed — per spec §5.4.
 */
const parked = computed(() => Math.floor((model.value.strengths.length - 1) / 2))

/**
 * Spec §5.5: 一个存储的强度模型不提供时，按原样显示，绝不改写. The value is kept, and this is what
 * says so — without it the slider parks its thumb on the midpoint and silently contradicts the
 * chip, which shows the stored value. Named `（不适用）` after the control this one replaced.
 */
const unsupportedLabel = computed(() => {
  const active = props.active
  if (!model.value.unsupported) return null
  if (active === 'inherit' || active === 'off' || active === 'auto') return null
  return REASONING_LABELS[active]
})

/** A one-stop axis is a single option, not a scale; the slider is replaced by a toggle for it. */
const loneStop = computed(() => (model.value.strengths.length === 1 ? model.value.strengths[0] : undefined))

function act(action: ReasoningAction) {
  emit('update', reasoningChoiceFor(model.value, action))
}

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
 * thumb already sits on would otherwise be a dead click; committing the parked stop on the first
 * press makes every stop live, and reka's own slide handling then writes whichever stop the
 * pointer landed on. The same is true whenever nothing is pinned — 自动 *or* an unsupported stored
 * strength — so the guard is `index < 0`, not `auto`.
 */
function onSliderPointerDown() {
  if (!model.value.enabled || model.value.index >= 0) return
  const stop = model.value.strengths[parked.value]
  if (stop) act({ kind: 'strength', stop })
}

/** The lone-stop toggle: pressing it pins that stop, releasing it hands the choice back to 自动. */
function onLoneStop(on: boolean) {
  const stop = loneStop.value
  if (on && stop) act({ kind: 'strength', stop })
  else if (!on) act({ kind: 'auto', on: true })
}
</script>

<template>
  <!-- One spacing scale for both hosts: a 320px popover and a settings form several hundred px
       wide. `gap-3` on the column is what separates the rows, so no child carries its own margin. -->
  <div class="flex flex-col gap-3">
    <!-- Nothing here can act, so the panel states why instead of rendering dead widgets (§5.1).
         The 默认 button survives: clearing an override that can no longer be edited is the one
         action still worth having. -->
    <div v-if="disabledReason" class="flex items-center justify-between gap-2">
      <p class="text-muted-foreground text-sm">
        {{ disabledReason }}
      </p>
      <Button v-if="overridden" variant="ghost" size="xs" type="button" @click="emit('update', 'inherit')">
        默认
      </Button>
    </div>

    <template v-else>
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">思考</span>
          <Switch
            :model-value="model.enabled"
            :disabled="!model.canDisable"
            @update:model-value="(on: boolean) => act({ kind: 'enable', on })"
          />
        </div>
        <Button v-if="overridden" variant="ghost" size="xs" type="button" @click="emit('update', 'inherit')">
          默认
        </Button>
      </div>

      <!-- The reason for the lock, as text. It used to be the Switch's `title`, which a disabled
           button can never show: browsers suppress pointer events on disabled form controls, so
           the tooltip never fires — the same trap ruling R7 fixed in the Composer. -->
      <p v-if="!model.canDisable" class="text-muted-foreground text-xs">
        该模型无法关闭思考，开关锁定在「开」。
      </p>

      <Separator />

      <div class="flex items-center gap-2">
        <span class="text-sm">自动</span>
        <Switch
          :model-value="model.auto"
          :disabled="!model.enabled"
          @update:model-value="(on: boolean) => act({ kind: 'auto', on })"
        />
      </div>

      <div v-if="model.strengths.length > 1">
        <Slider
          v-model="sliderValue"
          :min="0"
          :max="model.strengths.length - 1"
          :step="1"
          :disabled="!model.enabled"
          :class="cn(
            '[&_[data-slot=slider-thumb]]:size-5 [&_[data-slot=slider-thumb]]:shadow [&_[data-slot=slider-track]]:h-1.5',
            model.enabled && (model.auto || model.unsupported) ? 'opacity-50' : '',
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
              !model.enabled || model.auto || model.unsupported ? 'opacity-40' : '',
              i === model.index && model.enabled && !model.auto ? 'text-foreground font-medium' : '',
            )"
          >{{ REASONING_LABELS[stop] }}</span>
        </div>
      </div>

      <!-- A lone stop is not a scale. reka's `convertValueToPercentage` divides by `max - min`,
           which is 0 here, so the thumb's `left` computes to `calc(NaN% + NaNpx)`; the browser
           drops the invalid declaration and the thumb collapses onto the track's left edge while
           its label centres at 50%. There is also nothing to slide between: the only choices are
           "this level" and "let the provider decide", which is exactly a toggle. -->
      <Toggle
        v-else-if="loneStop"
        :model-value="model.index === 0"
        :disabled="!model.enabled"
        variant="outline"
        class="w-full"
        @update:model-value="onLoneStop"
      >
        {{ REASONING_LABELS[loneStop] }}
      </Toggle>

      <!-- A reasoning model that declares no strengths at all: 思考 and 自动 still mean something,
           there is simply no axis to draw. -->
      <p v-else class="text-muted-foreground text-xs">
        该模型未声明可选档位，强度由供应商决定。
      </p>

      <p v-if="unsupportedLabel" class="text-muted-foreground text-xs">
        当前档位「{{ unsupportedLabel }}」（不适用）：该模型未声明这一档，值按原样保留，未被改写。
      </p>
    </template>
  </div>
</template>
