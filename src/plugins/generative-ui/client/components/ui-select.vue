<script setup lang="ts">
import { computed } from 'vue'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import { isElement, type NodeProps } from '../runtime'
import { useField } from './use-field'

const { props } = defineProps<NodeProps<{
  name: string
  items?: unknown[]
  placeholder?: string
  rules?: unknown
  value?: unknown
}>>()
const options = computed(() => (props.items ?? [])
  .filter(item => isElement<{ value: string, label: string }>(item))
  .map(item => item.props))
const field = useField<string>('Select', () => props.name, () => props.value, () => props.rules)
</script>

<template lang="pug">
.flex.min-w-0.flex-col.gap-1
  //- Native on purpose: on a phone the OS picker beats any popover.
  NativeSelect(
    :model-value="String(field.value.value ?? '')" :disabled="field.disabled.value" class="w-full"
    :aria-invalid="field.error.value ? true : undefined" @update:model-value="field.set(String($event))")
    NativeSelectOption(value="" disabled) {{ props.placeholder ?? '请选择…' }}
    NativeSelectOption(v-for="option in options" :key="option.value" :value="option.value") {{ option.label }}
  .text-destructive.text-xs(v-if="field.error.value") {{ field.error.value }}
</template>
