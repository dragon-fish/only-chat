<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftIcon, CircleUserRoundIcon, FolderIcon, ImagesIcon, PaletteIcon, PlugIcon, ServerIcon, SettingsIcon, UsersIcon } from '@lucide/vue'
import { pluginManifests } from '@/client/plugins/loaders'
import { pluginSettingsEntries } from '@/shared/plugins'
import { activeNavTarget } from '@/client/lib/settings-nav'
import { useSyncStore } from '@/client/stores/sync'
import { useAuthStore } from '@/client/stores/auth'
import { isAuthAdmin } from '@/shared/auth'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSettingsReturn } from '@/client/composables/use-settings-return'
import {
  SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/client/ui/sidebar'

const route = useRoute()
const router = useRouter()
const returnTo = useSettingsReturn()
const auth = useAuthStore()
const sync = useSyncStore()
/** A disabled plugin keeps its page — reachable from 插件 — but loses its shortcut here. */
const pluginPages = computed(() => pluginSettingsEntries(pluginManifests, sync.settings.plugins))
/** Plugin pages live under `/settings/plugins/…`, so only the longest match may light up. */
const active = computed(() => activeNavTarget(route.path, [
  ...categories.map(category => category.to),
  ...administration.map(category => category.to),
  ...pluginPages.value.map(page => page.to),
]))
const categories = [
  { label: '账户', to: '/settings/account', icon: CircleUserRoundIcon },
  { label: '模型服务', to: '/settings/providers', icon: ServerIcon },
  { label: '图片生成', to: '/settings/images', icon: ImagesIcon },
  { label: '插件', to: '/settings/plugins', icon: PlugIcon },
  { label: '外观', to: '/settings/appearance', icon: PaletteIcon },
]
const administration = [
  { label: '用户管理', to: '/admin/users', icon: UsersIcon },
  { label: '注册设置', to: '/admin/settings', icon: SettingsIcon },
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
          SidebarMenuButton(data-settings-category as-child :is-active="active === category.to" class="min-h-10 md:min-h-0" :tooltip="category.label")
            RouterLink(:to="category.to")
              component(:is="category.icon")
              span {{ category.label }}
  //- Their own group: a plugin page is not a sub-page of 插件, which manages which plugins run.
  SidebarGroup(v-if="pluginPages.length" data-settings-plugin-pages)
    SidebarGroupLabel 插件数据管理
    SidebarGroupContent
      SidebarMenu
        SidebarMenuItem(v-for="page in pluginPages" :key="page.to")
          SidebarMenuButton(data-settings-plugin-page as-child :is-active="active === page.to" class="min-h-10 md:min-h-0" :tooltip="page.label")
            RouterLink(:to="page.to")
              FolderIcon
              span {{ page.label }}
  SidebarGroup(v-if="isAuthAdmin(auth.authUser)")
    SidebarGroupLabel 站点管理
    SidebarGroupContent
      SidebarMenu
        SidebarMenuItem(v-for="category in administration" :key="category.to")
          SidebarMenuButton(as-child :is-active="active === category.to" class="min-h-10 md:min-h-0" :tooltip="category.label")
            RouterLink(:to="category.to")
              component(:is="category.icon")
              span {{ category.label }}
</template>
