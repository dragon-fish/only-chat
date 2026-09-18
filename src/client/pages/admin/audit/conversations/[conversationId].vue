<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AdminAuditConversation from '@/client/views/admin-audit-conversation.vue'
import { routeParamToId } from '@/client/lib/route-params'
import { usePageTitle } from '@/client/composables/use-page-title'
usePageTitle('审计会话')
const route = useRoute()
const conversationId = computed(() => {
  const value = (route.params as Record<string, unknown>).conversationId
  return routeParamToId(typeof value === 'string' ? value : undefined)
})
</script>
<template><AdminAuditConversation v-if="conversationId !== null" :key="conversationId" :conversation-id="conversationId" /></template>
