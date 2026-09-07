<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppSidebar from '@/client/components/layout/app-sidebar.vue'
import MobileBottomNav from '@/client/components/layout/mobile-bottom-nav.vue'
import RouteHeader from '@/client/components/layout/route-header.vue'
import { cn } from '@/client/lib/utils'
import { provideSettingsReturn } from '@/client/composables/use-settings-return'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/client/ui/sidebar'

const route = useRoute()
provideSettingsReturn()
const hasComposer = computed(() => /^\/(?:project\/[^/]+\/)?(?:new|c\/[^/]+)$/.test(route.path))
const showMobileNav = computed(() => !hasComposer.value)
const routeRegionClass = computed(() => cn(
  'min-h-0 flex-1 overflow-hidden',
  showMobileNav.value ? 'oc-mobile-nav-offset' : 'oc-mobile-composer-safe',
))
</script>

<template>
  <SidebarProvider class="h-dvh min-h-0 overflow-hidden">
    <AppSidebar />
    <SidebarInset class="h-full min-h-0 overflow-hidden">
      <RouteHeader>
        <template #leading>
          <SidebarTrigger class="hidden md:inline-flex" />
        </template>
      </RouteHeader>

      <div :class="routeRegionClass">
        <slot />
      </div>
      <MobileBottomNav v-if="showMobileNav" />
    </SidebarInset>
  </SidebarProvider>
</template>
