<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SidebarBrand from '@/client/components/layout/sidebar-brand.vue'
import ChatSidebarContent from '@/client/components/layout/chat-sidebar-content.vue'
import SidebarGlobalFooter from '@/client/components/layout/sidebar-global-footer.vue'
import SettingsSidebarContent from '@/client/components/layout/settings-sidebar-content.vue'
import { routeParamToId } from '@/client/lib/route-params'
import { useSyncStore } from '@/client/stores/sync'
import { Sidebar, SidebarRail } from '@/client/ui/sidebar'

const route = useRoute()
const router = useRouter()
const sync = useSyncStore()
const isSettings = computed(() => route.path.startsWith('/settings'))

const activeConversationId = computed(() => routeParamToId(
  'conversationId' in route.params && typeof route.params.conversationId === 'string' ? route.params.conversationId : undefined,
))
const activeConversation = computed(() => activeConversationId.value === null ? undefined : sync.conversations.get(activeConversationId.value))

watch([activeConversationId, activeConversation], ([conversationId, conversation], [previousId, previousConversation]) => {
  if (conversationId !== null && conversationId === previousId && previousConversation !== undefined && conversation === undefined) {
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
    <SidebarBrand :status="sync.status" />
    <SettingsSidebarContent v-if="isSettings" />
    <ChatSidebarContent v-else :project-id="projectId" />
    <SidebarGlobalFooter />
    <SidebarRail />
  </Sidebar>
</template>
