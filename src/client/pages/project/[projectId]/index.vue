<script setup lang="ts">
import { computed } from 'vue'
import ProjectConversations from '@/client/views/project-conversations.vue'
import { usePageTitle } from '@/client/composables/use-page-title'
import { projectPresentation } from '@/client/lib/ui-models'
import { useSyncStore } from '@/client/stores/sync'

const props = defineProps<{ projectId: number | null }>()
const sync = useSyncStore()
usePageTitle(computed(() => {
  const project = props.projectId === null ? undefined : sync.projects.get(props.projectId)
  return project ? projectPresentation(project.name).title : 'Project'
}))
</script>

<template lang="pug">
ProjectConversations(:project-id="projectId")
</template>
