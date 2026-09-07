<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ProjectSessions from '@/client/views/project-sessions.vue'
import { routeParamToId } from '@/client/lib/route-params'

const route = useRoute('/projects/[projectId]')
const projectId = computed(() => routeParamToId(route.params.projectId))
</script>

<template>
  <ProjectSessions :project-id="projectId" />
</template>
