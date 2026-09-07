<script setup lang="ts">
import ChatView from '@/client/views/chat.vue'
defineProps<{ projectId: number | null }>()
</script>

<template lang="pug">
ChatView(:session-id="null" :project-id="projectId")
</template>
