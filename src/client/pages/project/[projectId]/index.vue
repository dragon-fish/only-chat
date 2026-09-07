<script setup lang="ts">
import ProjectSessions from '@/client/views/project-sessions.vue'
defineProps<{ projectId: number | null }>()
</script>

<template lang="pug">
ProjectSessions(:project-id="projectId")
</template>
