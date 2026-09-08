<script setup lang="ts">
import { computed } from 'vue'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/ui/avatar'
import { api } from '@/client/lib/api'
import { displayInitials, projectPresentation } from '@/client/lib/ui-models'
import type { Project } from '@/shared/models'

const props = withDefaults(defineProps<{
  project: Pick<Project, 'name' | 'icon_attachment_id'>
  size?: 'sm' | 'default'
}>(), {
  size: 'default',
})

const initials = computed(() => displayInitials(props.project.name, 'P'))
const presentation = computed(() => projectPresentation(props.project.name))
</script>

<template>
  <Avatar :size="size" :aria-label="project.name">
    <AvatarImage v-if="project.icon_attachment_id !== null" :src="api.attachmentUrl(project.icon_attachment_id)" :alt="project.name" />
    <AvatarFallback :class="presentation.icon ? 'oc-emoji' : undefined">{{ presentation.icon ?? initials }}</AvatarFallback>
  </Avatar>
</template>
