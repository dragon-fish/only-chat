<script setup lang="ts">
import { computed } from 'vue'
import { RenderValue, type NodeProps } from '../runtime'

const { props, renderNode } = defineProps<NodeProps<{ buttons?: unknown[], direction?: 'row' | 'column' }>>()
const items = computed(() => (props.buttons ?? []).filter(button => button != null))
</script>

<template lang="pug">
.flex.min-w-0.gap-2(:class="props.direction === 'column' ? 'flex-col items-stretch' : 'flex-wrap items-center'")
  RenderValue(v-for="(button, index) in items" :key="index" :value="button" :render="renderNode")
</template>
