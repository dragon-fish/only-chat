<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatSidebarContent from '@/client/components/layout/chat-sidebar-content.vue'
import SettingsSidebarContent from '@/client/components/layout/settings-sidebar-content.vue'
import { routeParamToId } from '@/client/lib/route-params'
import { useSyncStore } from '@/client/stores/sync'
import { Sidebar, SidebarRail } from '@/client/ui/sidebar'

const route = useRoute()
const router = useRouter()
const sync = useSyncStore()
const isSettings = computed(() => route.path.startsWith('/settings'))

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

  return undefined
})
</script>

<template>
  <Sidebar
    collapsible="icon"
    class="h-full"
    :data-sidebar-context="isSettings ? 'settings' : projectId === undefined ? 'chat' : 'project'"
    :data-connection="sync.status"
  >
    <SettingsSidebarContent v-if="isSettings" />
    <ChatSidebarContent v-else :project-id="projectId" />
    <SidebarRail />
  </Sidebar>
</template>
