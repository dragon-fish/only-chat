<script setup lang="ts">
import ProjectSessions from '@/client/views/project-sessions.vue'
import ProjectSettings from '@/client/views/project-settings.vue'
defineProps<{ projectId: number | null }>()
</script>

<template lang="pug">
ProjectSessions(:project-id="projectId")
ProjectSettings(:project-id="projectId")
</template>
