<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDownRightIcon, ArrowUpRightIcon } from '@lucide/vue'
import type { NodeProps } from '../runtime'

const { props } = defineProps<NodeProps<{
  label?: string
  value?: string | number | null
  delta?: string | null
  trend?: 'up' | 'down' | 'neutral' | null
  hint?: string | null
}>>()
const trendClass = computed(() => props.trend === 'up'
  ? 'text-success'
  : props.trend === 'down' ? 'text-destructive' : 'text-muted-foreground')
</script>

<template lang="pug">
.flex.min-w-0.flex-col.gap-1.rounded-lg.border.p-3
  .text-muted-foreground.truncate.text-xs {{ props.label }}
  .text-xl.font-semibold.tabular-nums.leading-tight.break-words {{ props.value ?? '—' }}
  .flex.items-center.gap-1.text-xs(v-if="props.delta || props.trend === 'up' || props.trend === 'down'" :class="trendClass")
    ArrowUpRightIcon(class="size-3.5" v-if="props.trend === 'up'")
    ArrowDownRightIcon(class="size-3.5" v-else-if="props.trend === 'down'")
    span(v-if="props.delta") {{ props.delta }}
  .text-muted-foreground.text-xs(v-if="props.hint") {{ props.hint }}
</template>
