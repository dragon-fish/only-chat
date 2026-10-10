<script setup lang="ts">
import { computed } from 'vue'
import { RenderValue, type NodeProps } from '../runtime'

const { props, renderNode } = defineProps<NodeProps<{
  children?: unknown[]
  gap?: 'none' | 's' | 'm' | 'l'
  align?: 'start' | 'center' | 'end' | 'stretch'
}>>()
const GAP = { none: 'gap-0', s: 'gap-2', m: 'gap-3', l: 'gap-5' } as const
const ALIGN = { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch' } as const
const items = computed(() => (props.children ?? []).filter(child => child != null))
</script>

<template lang="pug">
//- Each item claims at least 9rem, so three Stats fit a phone and anything wider wraps.
.flex.min-w-0.flex-wrap(:class="[GAP[props.gap ?? 'm'], ALIGN[props.align ?? 'stretch']]")
  .flex.min-w-0.flex-col(v-for="(child, index) in items" :key="index" class="flex-[1_1_9rem] *:flex-1")
    RenderValue(:value="child" :render="renderNode")
</template>
