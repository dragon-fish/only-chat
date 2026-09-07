<script setup lang="ts">
import { ArrowLeftIcon, PaletteIcon, PlugIcon, ServerIcon } from '@lucide/vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSettingsReturn } from '@/client/composables/use-settings-return'
import {
  SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/client/ui/sidebar'

const route = useRoute()
const router = useRouter()
const returnTo = useSettingsReturn()
const categories = [
  { label: '模型服务', to: '/settings/providers', icon: ServerIcon },
  { label: '插件', to: '/settings/plugins', icon: PlugIcon },
  { label: '外观', to: '/settings/appearance', icon: PaletteIcon },
]

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
  SidebarGroup
    SidebarGroupLabel 设置
    SidebarGroupContent
      SidebarMenu
        SidebarMenuItem(v-for="category in categories" :key="category.to")
          SidebarMenuButton(data-settings-category as-child :is-active="route.path.startsWith(category.to)" class="min-h-10 md:min-h-0" :tooltip="category.label")
            RouterLink(:to="category.to")
              component(:is="category.icon")
              span {{ category.label }}
</template>
