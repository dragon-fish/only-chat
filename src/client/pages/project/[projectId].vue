<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { routeParamToId } from '@/client/lib/route-params'

const route = useRoute('/project/[projectId]')
const projectId = computed(() => routeParamToId(typeof route.params.projectId === 'string' ? route.params.projectId : undefined))
</script>

<template lang="pug">
RouterView(v-slot="{ Component }")
  component(:is="Component" :project-id="projectId")
</template>
