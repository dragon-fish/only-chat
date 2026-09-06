<script setup lang="ts">
import { RouterLink } from 'vue-router'
import ProjectTree from '@/client/components/project-tree.vue'

const emit = defineEmits<{ navigate: [] }>()
</script>

<template lang="pug">
//- Spec §8: the header stays put and `ProjectTree`'s root is this region's only scroll owner.
.flex.h-full.flex-col
  .flex.items-center.justify-between.p-3
    RouterLink.text-sm.font-semibold(to="/" @click="emit('navigate')") 新对话
    RouterLink.text-xs.text-muted-foreground(to="/settings/providers" @click="emit('navigate')") 设置
  ProjectTree(@navigate="emit('navigate')")
</template>
