<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftIcon, ChevronRightIcon, CircleUserRoundIcon, FolderIcon, SparklesIcon, PaletteIcon, PlugIcon, ServerIcon, SettingsIcon, UsersIcon, MessagesSquareIcon, ServerCogIcon } from '@lucide/vue'
import { pluginManifests } from '@/client/plugins/loaders'
import { pluginSettingsEntries } from '@/shared/plugins'
import { useSyncStore } from '@/client/stores/sync'
import { RouterLink, useRouter } from 'vue-router'
import { useSettingsReturn } from '@/client/composables/use-settings-return'
import { useAuthStore } from '@/client/stores/auth'
import { isAuthAdmin } from '@/shared/auth'
import { useAuditEnabled } from '@/client/composables/use-audit-listing'
import { Button } from '@/client/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/client/ui/item'

const router = useRouter()
const returnTo = useSettingsReturn()
const auth = useAuthStore()
const sync = useSyncStore()
const pluginPages = computed(() => pluginSettingsEntries(pluginManifests, sync.settings.plugins))
const categories = [
  { label: '账户', description: '管理个人信息与登录密码', to: '/settings/account', icon: CircleUserRoundIcon },
  { label: '模型服务', description: '连接供应商，管理模型与能力', to: '/settings/providers', icon: ServerIcon },
  { label: '全局服务模型', description: '应用自己使用的文本与生图模型', to: '/settings/service-models', icon: SparklesIcon },
  { label: '插件', description: '管理聊天中的工具与扩展', to: '/settings/plugins', icon: PlugIcon },
  { label: '外观', description: '调整主题与显示偏好', to: '/settings/appearance', icon: PaletteIcon },
]
const auditEnabled = useAuditEnabled()
const administration = computed(() => [
  { label: '用户管理', description: '管理账户、角色与登录权限', to: '/admin/users', icon: UsersIcon },
  { label: '注册设置', description: '设置本站是否开放注册', to: '/admin/settings', icon: SettingsIcon },
  ...(auditEnabled.value ? [
    { label: '全站会话', description: '只读查看所有用户的会话', to: '/admin/audit/conversations', icon: MessagesSquareIcon },
    { label: '全站供应商', description: '只读查看所有用户的供应商配置', to: '/admin/audit/providers', icon: ServerCogIcon },
  ] : []),
])

function backToChat() {
  void router.push(returnTo.value)
}
</script>

<template lang="pug">
.oc-scroll.h-full.min-h-0.overflow-y-auto
  Teleport(to="#page-header" defer)
    span.truncate.text-sm.font-medium 设置
  .mx-auto.flex.w-full.max-w-2xl.flex-col.gap-6.p-4(class="md:p-8")
    .flex.flex-col.gap-2
      h1.text-2xl.font-semibold 设置
      p.text-sm.text-muted-foreground 让 OnlyChat 按你的方式工作。
    ItemGroup(class="gap-2")
      Item(v-for="category in categories" :key="category.to" as-child variant="outline")
        RouterLink(:to="category.to")
          ItemMedia(variant="icon")
            component(:is="category.icon")
          ItemContent
            ItemTitle {{ category.label }}
            ItemDescription {{ category.description }}
          ItemActions
            ChevronRightIcon
    template(v-if="pluginPages.length")
      h2.text-sm.font-medium.text-muted-foreground 插件数据管理
      ItemGroup(class="gap-2")
        Item(v-for="page in pluginPages" :key="page.to" as-child variant="outline")
          RouterLink(:to="page.to")
            ItemMedia(variant="icon")
              FolderIcon
            ItemContent
              ItemTitle {{ page.label }}
              ItemDescription {{ page.description }}
            ItemActions
              ChevronRightIcon
    template(v-if="isAuthAdmin(auth.authUser)")
      h2.text-sm.font-medium.text-muted-foreground 站点管理
      ItemGroup(class="gap-2")
        Item(v-for="category in administration" :key="category.to" as-child variant="outline")
          RouterLink(:to="category.to")
            ItemMedia(variant="icon")
              component(:is="category.icon")
            ItemContent
              ItemTitle {{ category.label }}
              ItemDescription {{ category.description }}
            ItemActions
              ChevronRightIcon
    Button(variant="ghost" class="min-h-10 self-start md:hidden" @click="backToChat")
      ArrowLeftIcon(data-icon="inline-start")
      | 返回聊天
</template>
