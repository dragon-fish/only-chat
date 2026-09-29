<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { withViewer } from '@/client/lib/image-viewer'
import { api } from '@/client/lib/api'
import { useAuditContext } from '@/client/lib/audit-context'
import { runIdOf, type ArtifactDto } from '@/shared/artifacts'
import type { TaskNotificationPart } from '@/shared/parts'

const props = defineProps<{ notification: TaskNotificationPart }>()
const auditing = useAuditContext() !== null
const route = useRoute()
const outputs = ref<ArtifactDto[]>([])
onMounted(async () => {
  const id = runIdOf(props.notification.task_id)
  if (id === null || auditing || props.notification.status !== 'completed') return
  try { outputs.value = (await api.artifacts({ run_id: id })).artifacts.sort((a, b) => a.output_index - b.output_index) }
  catch { outputs.value = [] }
})
</script>

<template lang="pug">
.flex.flex-wrap(class="gap-1.5" v-if="outputs.length")
  RouterLink(v-for="artifact in outputs" :key="artifact.id" :to="withViewer(route, artifact.id)" class="block size-14 overflow-hidden rounded-md border bg-muted")
    img.size-full.object-cover(:src="api.artifactContentUrl(artifact.id, 'gallery')" :alt="artifact.prompt" loading="lazy")
p.whitespace-pre-wrap.break-words.text-xs(v-else) {{ notification.text }}
</template>
