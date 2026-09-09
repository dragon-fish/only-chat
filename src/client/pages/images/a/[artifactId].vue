<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ImageArtifactDetail from '@/client/views/image-artifact-detail.vue'
import { routeParamToId } from '@/client/lib/route-params'
const route = useRoute()
const artifactId = computed(() => {
  const value = (route.params as Record<string, unknown>).artifactId
  return routeParamToId(typeof value === 'string' ? value : undefined)
})
</script>
<template><ImageArtifactDetail :artifact-id="artifactId" /></template>
