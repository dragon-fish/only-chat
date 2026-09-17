<script setup lang="ts">
import ProjectsIndex from '@/client/views/projects-index.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('Projects')
</script>

<template>
  <ProjectsIndex />
</template>
