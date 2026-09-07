<script setup lang="ts">
import { computed } from 'vue'
import { displayInitials } from '@/client/lib/ui-models'
import { Avatar, AvatarFallback } from '@/client/ui/avatar'

const props = withDefaults(defineProps<{
  name: string
  size?: 'sm' | 'default'
}>(), {
  size: 'default',
})

const initials = computed(() => displayInitials(props.name))
</script>

<template>
  <Avatar :size="size" :aria-label="name">
    <AvatarFallback>{{ initials }}</AvatarFallback>
  </Avatar>
</template>
