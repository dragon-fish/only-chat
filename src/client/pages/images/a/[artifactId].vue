<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ImageArtifactDetail from '@/client/views/image-artifact-detail.vue'
import { routeParamToId } from '@/client/lib/route-params'
import { usePageTitle } from '@/client/composables/use-page-title'
usePageTitle('图片详情')
const route = useRoute()
const artifactId = computed(() => {
  const value = (route.params as Record<string, unknown>).artifactId
  return routeParamToId(typeof value === 'string' ? value : undefined)
})
</script>
<template><ImageArtifactDetail :artifact-id="artifactId" /></template>
