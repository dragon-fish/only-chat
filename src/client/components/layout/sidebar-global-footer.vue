<script setup lang="ts">
import { SettingsIcon } from '@lucide/vue'
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import SidebarAccountMenu from '@/client/components/layout/sidebar-account-menu.vue'
import { SidebarFooter, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/client/ui/sidebar'

const route = useRoute()
const isSettings = computed(() => route.path.startsWith('/settings'))
</script>

<template>
  <SidebarFooter data-sidebar-global-footer>
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton data-global-settings as-child class="min-h-10 md:min-h-0" :is-active="isSettings" tooltip="设置">
          <RouterLink to="/settings">
            <SettingsIcon />
            <span>设置</span>
          </RouterLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
    <SidebarAccountMenu />
  </SidebarFooter>
</template>
