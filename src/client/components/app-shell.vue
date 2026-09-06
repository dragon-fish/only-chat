<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TriangleAlertIcon, XIcon } from '@lucide/vue'
import { useRoute } from 'vue-router'
import AppSidebar from '@/client/components/layout/app-sidebar.vue'
import MobileBottomNav from '@/client/components/layout/mobile-bottom-nav.vue'
import RouteHeader from '@/client/components/layout/route-header.vue'
import { cn } from '@/client/lib/utils'
import { useSyncStore } from '@/client/stores/sync'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/client/ui/sidebar'

const props = defineProps<{ bootError?: string | null }>()

const route = useRoute()
const sync = useSyncStore()
const bootErrorDismissed = ref(false)

watch(() => props.bootError, () => { bootErrorDismissed.value = false })

const visibleBootError = computed(() => !bootErrorDismissed.value && props.bootError)
const hasComposer = computed(() => route.path === '/' || /^\/c\/[^/]+$/.test(route.path))
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

      <div
        v-if="visibleBootError || sync.lastError"
        class="flex shrink-0 flex-col gap-2 px-3 pt-2"
      >
        <Alert v-if="visibleBootError" variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>请刷新重试：{{ visibleBootError }}</AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-xs"
              class="size-10"
              aria-label="关闭加载错误"
              @click="bootErrorDismissed = true"
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>

        <Alert v-if="sync.lastError" variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{{ sync.lastError }}</AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-xs"
              class="size-10"
              aria-label="关闭操作错误"
              @click="sync.lastError = null"
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      </div>

      <div :class="routeRegionClass">
        <slot />
      </div>
      <MobileBottomNav v-if="showMobileNav" />
    </SidebarInset>
  </SidebarProvider>
</template>
