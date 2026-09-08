<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ChatView from '@/client/views/chat.vue'
import { routeParamToId } from '@/client/lib/route-params'

definePage({ path: '/new/:sessionId?', alias: ['/c/:sessionId?'] })
const route = useRoute('/new')
const sessionId = computed(() => routeParamToId(typeof route.params.sessionId === 'string' ? route.params.sessionId : undefined))
</script>

<template lang="pug">
ChatView(:session-id="sessionId")
</template>
