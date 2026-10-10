<script setup lang="ts">
import { Input } from '@/client/ui/input'
import { Textarea } from '@/client/ui/textarea'
import type { NodeProps } from '../runtime'
import { useField } from './use-field'

const { props, multiline = false } = defineProps<NodeProps<{
  name: string
  placeholder?: string
  type?: 'text' | 'email' | 'number' | 'url'
  rows?: number
  rules?: unknown
  value?: unknown
}> & { multiline?: boolean }>()
const field = useField<string>(multiline ? 'TextArea' : 'Input', () => props.name, () => props.value, () => props.rules)
</script>

<template lang="pug">
.flex.min-w-0.flex-col.gap-1
  Textarea(
    v-if="multiline" :model-value="String(field.value.value ?? '')" :placeholder="props.placeholder"
    :rows="props.rows ?? 3" :disabled="field.disabled.value" :aria-invalid="field.error.value ? true : undefined"
    @update:model-value="field.set(String($event))")
  Input(
    v-else :model-value="String(field.value.value ?? '')" :placeholder="props.placeholder"
    :type="props.type ?? 'text'" :disabled="field.disabled.value" :aria-invalid="field.error.value ? true : undefined"
    class="h-10 md:h-8" @update:model-value="field.set(String($event))")
  .text-destructive.text-xs(v-if="field.error.value") {{ field.error.value }}
</template>
