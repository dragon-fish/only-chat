<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ChatView from '@/client/views/chat.vue'
import { routeParamToId } from '@/client/lib/route-params'

definePage({
  path: '/project/:projectId/new/:sessionId?',
  alias: ['/project/:projectId/c/:sessionId?'],
})
defineProps<{ projectId: number | null }>()
const route = useRoute('/project/[projectId]/new')
const sessionId = computed(() => routeParamToId(typeof route.params.sessionId === 'string' ? route.params.sessionId : undefined))
</script>

<template lang="pug">
ChatView(:session-id="sessionId" :project-id="projectId")
</template>
