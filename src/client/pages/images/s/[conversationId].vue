<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ImageStudio from '@/client/views/image-studio.vue'
import { routeParamToId } from '@/client/lib/route-params'
const route = useRoute()
const conversationId = computed(() => {
  const value = (route.params as Record<string, unknown>).conversationId
  return routeParamToId(typeof value === 'string' ? value : undefined)
})
</script>
<template><ImageStudio :conversation-id="conversationId" /></template>
