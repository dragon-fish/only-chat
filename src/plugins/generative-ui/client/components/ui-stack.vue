<script setup lang="ts">
import { computed } from 'vue'
import { RenderValue, type NodeProps } from '../runtime'

const { props, renderNode } = defineProps<NodeProps<{ children?: unknown[], gap?: 'none' | 's' | 'm' | 'l' }>>()
const GAP = { none: 'gap-0', s: 'gap-2', m: 'gap-3', l: 'gap-5' } as const
const items = computed(() => (props.children ?? []).filter(child => child != null))
</script>

<template lang="pug">
.flex.min-w-0.flex-col(:class="GAP[props.gap ?? 'm']")
  RenderValue(v-for="(child, index) in items" :key="index" :value="child" :render="renderNode")
</template>
