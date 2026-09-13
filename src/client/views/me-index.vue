<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRightIcon, CircleUserRoundIcon, FolderIcon, ImagesIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { pluginManifests } from '@/client/plugins/loaders'
import { pluginSettingsEntries } from '@/shared/plugins'
import { useAuthStore } from '@/client/stores/auth'
import { useSyncStore } from '@/client/stores/sync'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/ui/avatar'
import { Button } from '@/client/ui/button'
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
  .mx-auto.w-full.max-w-2xl
    //- The banner is the app's own black rather than a decorative wash: it is the same surface as
    //- the compose button, and it exists to give the avatar an edge to sit on until an image can.
    .bg-primary.h-24(class="md:h-32")
    .flex.flex-col.gap-6.px-4.pb-6(class="md:px-8")
      .flex.flex-col.gap-3
        //- Half the avatar sits on the banner, which is the only place its ring is visible.
        Avatar(class="-mt-12 size-20 ring-4 ring-background md:-mt-14 md:size-24")
          AvatarImage(v-if="auth.authUser?.image" :src="auth.authUser.image" :alt="auth.authUser.name")
          AvatarFallback
            CircleUserRoundIcon(class="size-10")
        .flex.items-start.justify-between.gap-3
          .min-w-0
            h1.truncate.text-xl.font-semibold.leading-tight {{ auth.authUser?.name || '未登录' }}
            p.truncate.text-sm.text-muted-foreground {{ auth.authUser?.email }}
          Button(as-child variant="outline" size="sm" class="min-h-10 shrink-0 md:min-h-8")
            RouterLink(to="/settings/account") 编辑资料

      ItemGroup(class="gap-2")
        Item(as-child variant="outline")
          RouterLink(to="/images")
            ItemMedia(variant="icon")
              ImagesIcon
            ItemContent
              ItemTitle 图片 Gallery
              ItemDescription 生成过的全部图片
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
