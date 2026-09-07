<script setup lang="ts">
import { computed } from 'vue'
import { Avatar, AvatarFallback } from '@/client/ui/avatar'

const props = withDefaults(defineProps<{
  name: string
  size?: 'sm' | 'default'
}>(), {
  size: 'default',
})

const initials = computed(() => {
  const value = props.name.trim()
  if (!value) return 'P'
  const words = value.split(/\s+/).filter(Boolean)
  if (words.length > 1) return words.slice(0, 2).map(word => word[0]).join('').toLocaleUpperCase()
  return Array.from(value).slice(0, 2).join('').toLocaleUpperCase()
})
</script>

<template>
  <Avatar :size="size" :aria-label="name">
    <AvatarFallback>{{ initials }}</AvatarFallback>
  </Avatar>
</template>
