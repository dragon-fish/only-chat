<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftIcon } from '@lucide/vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { activeNavTarget } from '@/client/lib/settings-nav'
import { useSettingsReturn } from '@/client/composables/use-settings-return'
import { useSettingsNavStore } from '@/client/stores/settings-nav'
import {
  SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/client/ui/sidebar'

const route = useRoute()
const router = useRouter()
const returnTo = useSettingsReturn()
const nav = useSettingsNavStore()
/** Plugin pages live under `/settings/plugins/…`, so only the longest match may light up. */
const active = computed(() => activeNavTarget(route.path, nav.targets))

function backToChat() {
  void router.push(returnTo.value)
}
</script>

<template lang="pug">
SidebarHeader(data-settings-header)
  SidebarMenu
    SidebarMenuItem
      SidebarMenuButton(data-settings-back class="min-h-10 md:min-h-0" tooltip="返回聊天" @click="backToChat")
        ArrowLeftIcon
        span 返回聊天
SidebarContent(data-settings-content)
  SidebarGroup(v-for="group in nav.groups" :key="group.id" :data-settings-group="group.id")
    SidebarGroupLabel {{ group.label }}
    SidebarGroupContent
      SidebarMenu
        SidebarMenuItem(v-for="item in group.items" :key="item.to")
          SidebarMenuButton(as-child :is-active="active === item.to" class="min-h-10 md:min-h-0" :tooltip="item.label")
            RouterLink(:to="item.to")
              component(:is="item.icon")
              span {{ item.label }}
</template>
