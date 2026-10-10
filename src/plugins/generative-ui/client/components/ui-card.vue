<script setup lang="ts">
import { computed } from 'vue'
import { RenderValue, type NodeProps } from '../runtime'

const { props, renderNode } = defineProps<NodeProps<{ children?: unknown[], title?: string, description?: string }>>()
const items = computed(() => (props.children ?? []).filter(child => child != null))
</script>

<template lang="pug">
.bg-card.text-card-foreground.flex.min-w-0.flex-col.gap-3.rounded-xl.p-4.text-sm(class="ring-1 ring-foreground/10")
  .flex.flex-col(class="gap-0.5" v-if="props.title || props.description")
    .text-base.font-medium(v-if="props.title") {{ props.title }}
    .text-muted-foreground(v-if="props.description") {{ props.description }}
  RenderValue(v-for="(child, index) in items" :key="index" :value="child" :render="renderNode")
</template>
