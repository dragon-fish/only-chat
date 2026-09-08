<script setup lang="ts">
import { CircleUserRoundIcon } from '@lucide/vue'
import { SidebarMenu, SidebarMenuItem } from '@/client/ui/sidebar'
</script>

<template>
  <SidebarMenu>
    <SidebarMenuItem>
      <div class="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm md:min-h-0 md:h-8 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2">
        <CircleUserRoundIcon class="size-4 shrink-0" />
        <span class="min-w-0 group-data-[collapsible=icon]:hidden">
          <span class="block truncate font-medium">Only Chat User</span>
          <span class="block truncate text-xs text-muted-foreground">本地账户</span>
        </span>
      </div>
    </SidebarMenuItem>
  </SidebarMenu>
</template>
