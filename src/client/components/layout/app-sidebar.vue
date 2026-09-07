<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatSidebarContent from '@/client/components/layout/chat-sidebar-content.vue'
import { routeParamToId } from '@/client/lib/route-params'
import { useSyncStore } from '@/client/stores/sync'
import { Sidebar } from '@/client/ui/sidebar'

const route = useRoute()
const router = useRouter()
const sync = useSyncStore()

const activeSessionId = computed(() => routeParamToId(
  'sessionId' in route.params && typeof route.params.sessionId === 'string' ? route.params.sessionId : undefined,
))
const activeSession = computed(() => activeSessionId.value === null ? undefined : sync.sessions.get(activeSessionId.value))

watch([activeSessionId, activeSession], ([sessionId, session], [previousId, previousSession]) => {
  if (sessionId !== null && sessionId === previousId && previousSession !== undefined && session === undefined) {
    void router.replace('/chats')
  }
})

const projectId = computed<number | undefined>(() => {
  if (route.path.startsWith('/settings')) return undefined

  const routeProjectId = routeParamToId(
    'projectId' in route.params && typeof route.params.projectId === 'string' ? route.params.projectId : undefined,
  )
  if (routeProjectId !== null) return routeProjectId

  const draftProjectId = routeParamToId(typeof route.query.project === 'string' ? route.query.project : undefined)
  if (draftProjectId !== null) return draftProjectId

  return activeSession.value?.project_id ?? undefined
})
</script>

<template>
  <Sidebar
    collapsible="offcanvas"
    class="h-full"
    :data-sidebar-context="projectId === undefined ? 'chat' : 'project'"
    :data-connection="sync.status"
  >
    <ChatSidebarContent :project-id="projectId" />
  </Sidebar>
</template>
