<script setup lang="ts">
import { computed } from 'vue'
import { Slider } from '@/client/ui/slider'
import type { NodeProps } from '../runtime'
import { useField } from './use-field'

const { props } = defineProps<NodeProps<{
  name: string
  min?: number
  max?: number
  step?: number
  value?: unknown
  unit?: string
}>>()
const min = computed(() => Number(props.min ?? 0))
const max = computed(() => Number(props.max ?? 100))
const field = useField<number>('Slider', () => props.name, () => props.value, () => undefined, min.value)
const current = computed(() => {
  const value = Number(field.value.value)
  return Number.isFinite(value) ? Math.min(max.value, Math.max(min.value, value)) : min.value
})
const step = computed(() => props.step && props.step > 0 ? props.step : 1)
function onSlide(value: number[] | undefined) {
  if (value?.[0] !== undefined) field.set(value[0])
}
/** Rounded to the step's own precision: 0.1 + 0.2 must not show as 0.30000000000000004. */
const display = computed(() => {
  const decimals = (String(step.value).split('.')[1] ?? '').length
  return current.value.toLocaleString(undefined, { maximumFractionDigits: decimals })
})
</script>

<template lang="pug">
.flex.min-w-0.items-center.gap-3
  //- Tall hit area for a thumb on a phone; the track itself stays thin.
  Slider(
    :model-value="[current]" :min="min" :max="max" :step="step" :disabled="field.disabled.value"
    class="h-8 flex-1" @update:model-value="onSlide")
  span.shrink-0.text-right.text-sm.tabular-nums(class="min-w-16") {{ display }}{{ props.unit ? ` ${props.unit}` : '' }}
</template>
