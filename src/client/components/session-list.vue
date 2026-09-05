<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useSyncStore } from '@/client/stores/sync'

const emit = defineEmits<{ navigate: [] }>()
const sync = useSyncStore()
</script>

<template lang="pug">
.flex.h-full.flex-col
  .flex.items-center.justify-between.p-3
    RouterLink.text-sm.font-semibold(to="/" @click="emit('navigate')") 新对话
    RouterLink.text-xs.text-muted-foreground(to="/settings/providers" @click="emit('navigate')") 设置
  .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-2.pb-2
    RouterLink.block.truncate.rounded-md.px-2.py-1.text-sm(
      v-for="s in sync.sessionList" :key="s.id" :to="`/c/${s.id}`"
      class="hover:bg-accent" active-class="bg-accent" @click="emit('navigate')") {{ s.title }}
</template>
