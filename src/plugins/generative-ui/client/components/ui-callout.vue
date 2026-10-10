<script setup lang="ts">
import { computed } from 'vue'
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from '@lucide/vue'
import type { NodeProps } from '../runtime'

type Variant = 'info' | 'success' | 'warning' | 'error' | 'neutral'
const { props } = defineProps<NodeProps<{ variant?: Variant, title?: string, description?: string }>>()
const STYLE: Record<Variant, { box: string, icon: unknown }> = {
  info: { box: 'border-sky-500/30 bg-sky-500/10 [&_svg]:text-sky-600 dark:[&_svg]:text-sky-400', icon: InfoIcon },
  success: { box: 'border-success/30 bg-success/10 [&_svg]:text-success', icon: CircleCheckIcon },
  warning: { box: 'border-warning/40 bg-warning/15 [&_svg]:text-amber-600 dark:[&_svg]:text-warning', icon: TriangleAlertIcon },
  error: { box: 'border-destructive/30 bg-destructive/10 [&_svg]:text-destructive', icon: CircleAlertIcon },
  neutral: { box: 'border-border bg-muted/50 [&_svg]:text-muted-foreground', icon: InfoIcon },
}
const style = computed(() => STYLE[props.variant ?? 'info'] ?? STYLE.info)
</script>

<template lang="pug">
.flex.min-w-0.gap-2.rounded-lg.border.p-3.text-sm(:class="style.box")
  component.size-4.shrink-0(:is="style.icon" class="mt-0.5")
  .flex.min-w-0.flex-col(class="gap-0.5")
    .font-medium.break-words {{ props.title }}
    .text-muted-foreground.break-words(v-if="props.description") {{ props.description }}
</template>
