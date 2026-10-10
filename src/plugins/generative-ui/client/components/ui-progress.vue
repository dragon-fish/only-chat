<script setup lang="ts">
import { computed } from 'vue'
import { Progress } from '@/client/ui/progress'
import type { NodeProps } from '../runtime'

const { props } = defineProps<NodeProps<{ value?: number, max?: number, label?: string }>>()
const percent = computed(() => {
  const max = props.max && props.max > 0 ? props.max : 100
  return Math.min(100, Math.max(0, (Number(props.value) || 0) / max * 100))
})
</script>

<template lang="pug">
.flex.min-w-0.flex-col(class="gap-1.5")
  .flex.items-center.justify-between.gap-2.text-xs
    span.text-muted-foreground.truncate {{ props.label }}
    span.tabular-nums {{ Math.round(percent) }}%
  Progress(:model-value="percent" class="h-2")
</template>
