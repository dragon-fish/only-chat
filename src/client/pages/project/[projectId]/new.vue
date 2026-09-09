<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ChatView from '@/client/views/chat.vue'
import { routeParamToId } from '@/client/lib/route-params'

definePage({
  path: '/project/:projectId/new/:conversationId?',
  alias: ['/project/:projectId/c/:conversationId?'],
})
defineProps<{ projectId: number | null }>()
const route = useRoute('/project/[projectId]/new')
const conversationId = computed(() => routeParamToId(typeof route.params.conversationId === 'string' ? route.params.conversationId : undefined))
</script>

<template lang="pug">
ChatView(:conversation-id="conversationId" :project-id="projectId")
</template>
