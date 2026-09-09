<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ChatView from '@/client/views/chat.vue'
import { routeParamToId } from '@/client/lib/route-params'

definePage({ path: '/new/:conversationId?', alias: ['/c/:conversationId?'] })
const route = useRoute('/new')
const conversationId = computed(() => routeParamToId(typeof route.params.conversationId === 'string' ? route.params.conversationId : undefined))
</script>

<template lang="pug">
ChatView(:conversation-id="conversationId")
</template>
