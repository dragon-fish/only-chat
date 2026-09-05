<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ChatView from '@/client/views/chat.vue'
import { routeParamToId } from '@/client/lib/route-params'

const route = useRoute('/c/[sessionId]')
const sessionId = computed(() => routeParamToId(route.params.sessionId))
</script>

<template lang="pug">
ChatView(:session-id="sessionId")
</template>
