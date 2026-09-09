<script setup lang="ts">
import ProjectConversations from '@/client/views/project-conversations.vue'
import ProjectSettings from '@/client/views/project-settings.vue'
defineProps<{ projectId: number | null }>()
</script>

<template lang="pug">
ProjectConversations(:project-id="projectId")
ProjectSettings(:project-id="projectId")
</template>
