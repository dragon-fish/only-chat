<script setup lang="ts">
import { ArrowLeftIcon, ChevronRightIcon, PaletteIcon, PlugIcon, ServerIcon } from '@lucide/vue'
import { RouterLink, useRouter } from 'vue-router'
import { useSettingsReturn } from '@/client/composables/use-settings-return'
import { Button } from '@/client/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/client/ui/item'

const router = useRouter()
const returnTo = useSettingsReturn()
const categories = [
  { label: '模型服务', description: '连接供应商，管理模型与能力', to: '/settings/providers', icon: ServerIcon },
  { label: '插件', description: '管理聊天中的工具与扩展', to: '/settings/plugins', icon: PlugIcon },
  { label: '外观', description: '调整主题与显示偏好', to: '/settings/appearance', icon: PaletteIcon },
]

function backToChat() {
  void router.push(returnTo.value)
}
</script>

<template lang="pug">
.oc-scroll.h-full.min-h-0.overflow-y-auto
  Teleport(to="#page-header")
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
    Button(variant="ghost" class="min-h-10 self-start md:hidden" @click="backToChat")
      ArrowLeftIcon(data-icon="inline-start")
      | 返回聊天
</template>
