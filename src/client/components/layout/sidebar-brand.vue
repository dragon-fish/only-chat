<script setup lang="ts">
import { computed } from 'vue'
import { MessageCircleIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/client/ui/sidebar'
import type { WsStatus } from '@/client/lib/ws-client'

const props = defineProps<{
  status: WsStatus
}>()

const statusLabel = computed(() => ({
  open: '服务器已连接',
  connecting: '正在连接服务器',
  closed: '服务器连接已断开，正在重试',
}[props.status]))

const statusColor = computed(() => ({
  open: 'bg-success',
  connecting: 'bg-yellow-500',
  closed: 'bg-destructive',
}[props.status]))
</script>

<template>
  <SidebarHeader data-sidebar-brand>
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton as-child size="lg" tooltip="Only Chat" class="relative">
          <RouterLink to="/new">
            <div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <MessageCircleIcon />
            </div>
            <span class="font-semibold">Only Chat</span>
            <span
              data-connection-status
              :data-status="status"
              :aria-label="statusLabel"
              :title="statusLabel"
              tabindex="0"
              :class="[statusColor, 'ml-auto size-2 shrink-0 rounded-full ring-2 ring-sidebar group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:right-0.5 group-data-[collapsible=icon]:bottom-0.5']"
            />
          </RouterLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarHeader>
</template>
