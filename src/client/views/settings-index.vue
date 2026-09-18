<script setup lang="ts">
import { ArrowLeftIcon, ChevronRightIcon } from '@lucide/vue'
import { RouterLink, useRouter } from 'vue-router'
import { useSettingsReturn } from '@/client/composables/use-settings-return'
import { useSettingsNavStore } from '@/client/stores/settings-nav'
import { Button } from '@/client/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/client/ui/item'

const router = useRouter()
const returnTo = useSettingsReturn()
const nav = useSettingsNavStore()

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
    //- The page's own title names the first group, so only the others get a heading.
    template(v-for="group in nav.groups" :key="group.id")
      h2.text-sm.font-medium.text-muted-foreground(v-if="group.id !== 'settings'") {{ group.label }}
      ItemGroup(class="gap-2" :data-settings-group="group.id")
        Item(v-for="item in group.items" :key="item.to" as-child variant="outline")
          RouterLink(:to="item.to")
            ItemMedia(variant="icon")
              component(:is="item.icon")
            ItemContent
              ItemTitle {{ item.label }}
              ItemDescription {{ item.description }}
            ItemActions
              ChevronRightIcon
    Button(variant="ghost" class="min-h-10 self-start md:hidden" @click="backToChat")
      ArrowLeftIcon(data-icon="inline-start")
      | 返回聊天
</template>
