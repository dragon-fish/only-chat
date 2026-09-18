<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AdminAuditConversation from '@/client/views/admin-audit-conversation.vue'
import { routeParamToId } from '@/client/lib/route-params'
import { usePageTitle } from '@/client/composables/use-page-title'
usePageTitle('审计会话')
const route = useRoute()
const param = (name: string) => {
  const value = (route.params as Record<string, unknown>)[name]
  return routeParamToId(typeof value === 'string' ? value : undefined)
}
const userId = computed(() => param('userId'))
const conversationId = computed(() => param('conversationId'))
</script>
<template><AdminAuditConversation v-if="userId !== null && conversationId !== null" :key="`${userId}/${conversationId}`" :user-id="userId" :conversation-id="conversationId" /></template>
