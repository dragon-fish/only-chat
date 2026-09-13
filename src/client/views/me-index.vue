<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRightIcon, CircleUserRoundIcon, FolderIcon, ImagesIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { pluginManifests } from '@/client/plugins/loaders'
import { pluginSettingsEntries } from '@/shared/plugins'
import { useAuthStore } from '@/client/stores/auth'
import { useSyncStore } from '@/client/stores/sync'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/client/ui/item'

const auth = useAuthStore()
const sync = useSyncStore()

/**
 * Whatever the enabled plugins declare, in the order they declare it. This page knows no plugin by
 * name: a plugin earns a row here by having a `settingsEntry` in its manifest, and owns the words
 * in it. Rendering a live summary per row was tried and removed — it cost a full listing of every
 * file row to print one sentence, and a number that need not be exact belongs in a cache on the
 * server, not in a fetch on every visit.
 */
const pluginPages = computed(() => pluginSettingsEntries(pluginManifests, sync.settings.plugins))
</script>

<template lang="pug">
.oc-scroll.h-full.min-h-0.overflow-y-auto
  Teleport(to="#page-header" defer)
    span.truncate.text-sm.font-medium 我的
  .mx-auto.flex.w-full.max-w-2xl.flex-col.gap-6.p-4(class="md:p-8")
    .flex.flex-col.gap-2
      h1.text-2xl.font-semibold 我的
      p.text-sm.text-muted-foreground 你的账号，以及属于你的内容。

    ItemGroup(class="gap-2")
      Item(as-child variant="outline")
        RouterLink(to="/settings/account")
          ItemMedia(variant="icon")
            CircleUserRoundIcon
          ItemContent
            ItemTitle {{ auth.authUser?.name || '账号' }}
            ItemDescription {{ auth.authUser?.email || '管理个人信息与登录密码' }}
          ItemActions
            ChevronRightIcon

      Item(as-child variant="outline")
        RouterLink(to="/images")
          ItemMedia(variant="icon")
            ImagesIcon
          ItemContent
            ItemTitle 图片 Gallery
            ItemDescription 你生成过的全部图片
          ItemActions
            ChevronRightIcon

      Item(v-for="page in pluginPages" :key="page.to" as-child variant="outline")
        RouterLink(:to="page.to")
          ItemMedia(variant="icon")
            FolderIcon
          ItemContent
            ItemTitle {{ page.label }}
            ItemDescription {{ page.description }}
          ItemActions
            ChevronRightIcon
</template>
