<script setup lang="ts">
import type { NodeProps } from '../runtime'

type Variant = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
const { props } = defineProps<NodeProps<{ text?: string, variant?: Variant }>>()
const STYLE: Record<Variant, string> = {
  neutral: 'bg-muted text-foreground',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/20 text-amber-700 dark:text-warning',
  danger: 'bg-destructive/15 text-destructive',
}
</script>

<template lang="pug">
span.inline-flex.w-fit.max-w-full.items-center.truncate.rounded-full.px-2.text-xs.font-medium(
  class="py-0.5" :class="STYLE[props.variant ?? 'neutral'] ?? STYLE.neutral") {{ props.text }}
</template>
