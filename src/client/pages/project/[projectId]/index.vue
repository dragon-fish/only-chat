<script setup lang="ts">
import ProjectConversations from '@/client/views/project-conversations.vue'
defineProps<{ projectId: number | null }>()
</script>

<template lang="pug">
ProjectConversations(:project-id="projectId")
</template>
