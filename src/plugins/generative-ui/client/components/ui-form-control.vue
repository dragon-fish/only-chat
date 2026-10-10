<script setup lang="ts">
import { RenderValue, type NodeProps } from '../runtime'

const { props, renderNode } = defineProps<NodeProps<{ label?: string, input?: unknown, hint?: string }>>()
</script>

<template lang="pug">
.flex.min-w-0.flex-col(class="gap-1.5")
  .text-sm.font-medium(v-if="props.label") {{ props.label }}
  RenderValue(:value="props.input" :render="renderNode")
  .text-muted-foreground.text-xs(v-if="props.hint") {{ props.hint }}
</template>
