<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import ProjectSettingsView from '@/client/views/project-settings.vue'
import { routeParamToId } from '@/client/lib/route-params'

const route = useRoute('/settings/projects/[id]')
const projectId = computed(() => routeParamToId(route.params.id))
</script>

<template lang="pug">
ProjectSettingsView(:project-id="projectId")
</template>
