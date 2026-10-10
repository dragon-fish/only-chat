<script setup lang="ts">
import { Checkbox } from '@/client/ui/checkbox'
import { Switch } from '@/client/ui/switch'
import type { NodeProps } from '../runtime'
import { useField } from './use-field'

const { props, kind } = defineProps<NodeProps<{ name: string, label?: string, value?: unknown, description?: string }> & { kind: 'switch' | 'checkbox' }>()
const field = useField<boolean>(kind === 'switch' ? 'Switch' : 'Checkbox', () => props.name, () => props.value, () => undefined, false)
</script>

<template lang="pug">
label.flex.min-h-10.cursor-pointer.items-center.gap-3(class="md:min-h-8")
  Switch(
    v-if="kind === 'switch'" :model-value="field.value.value === true" :disabled="field.disabled.value"
    @update:model-value="field.set($event === true)")
  Checkbox(
    v-else :model-value="field.value.value === true" :disabled="field.disabled.value"
    @update:model-value="field.set($event === true)")
  span.flex.min-w-0.flex-col
    span.text-sm {{ props.label }}
    span.text-muted-foreground.text-xs(v-if="props.description") {{ props.description }}
</template>
