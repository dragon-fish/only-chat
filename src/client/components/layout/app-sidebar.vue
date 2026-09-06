<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SessionList from '@/client/components/session-list.vue'
import { useSyncStore } from '@/client/stores/sync'
import { Sidebar, SidebarContent } from '@/client/ui/sidebar'

const route = useRoute()
const sync = useSyncStore()

const context = computed<'chat' | 'project' | 'settings'>(() => {
  if (route.path.startsWith('/settings')) return 'settings'

  const routeSessionId = Number(route.path.startsWith('/c/') ? route.path.slice(3) : Number.NaN)
  const sessionProjectId = Number.isFinite(routeSessionId)
    ? sync.sessions.get(routeSessionId)?.project_id
    : null
  if (route.query.project !== undefined || sessionProjectId != null) return 'project'
  return 'chat'
})
</script>

<template>
  <Sidebar
    collapsible="offcanvas"
    class="h-full"
    :data-sidebar-context="context"
    :data-connection="sync.status"
  >
    <SidebarContent class="overflow-hidden">
      <slot :name="context" :route="route" :sync="sync">
        <SessionList />
      </slot>
    </SidebarContent>
  </Sidebar>
</template>
