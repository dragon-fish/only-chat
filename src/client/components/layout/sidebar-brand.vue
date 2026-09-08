<script setup lang="ts">
import { computed } from 'vue'
import { MessageCircleIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/client/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/ui/tooltip'
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
  connecting: 'bg-warning',
  closed: 'bg-destructive',
}[props.status]))
</script>

<template>
  <SidebarHeader data-sidebar-brand>
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton as-child size="lg" tooltip="Only Chat" class="pr-10">
          <RouterLink to="/new">
            <div class="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <MessageCircleIcon />
            </div>
            <span class="font-semibold">Only Chat</span>
          </RouterLink>
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger
            data-connection-status
            :data-status="status"
            :aria-label="statusLabel"
            type="button"
            class="ring-sidebar-ring absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded-md outline-hidden focus-visible:ring-2 group-data-[collapsible=icon]:top-auto group-data-[collapsible=icon]:right-0 group-data-[collapsible=icon]:bottom-0 group-data-[collapsible=icon]:size-4 group-data-[collapsible=icon]:translate-y-0"
          >
            <span aria-hidden="true" :class="[statusColor, 'size-2 shrink-0 rounded-full ring-2 ring-sidebar']" />
          </TooltipTrigger>
          <TooltipContent side="right" :side-offset="4">{{ statusLabel }}</TooltipContent>
        </Tooltip>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarHeader>
</template>
