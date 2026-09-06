<script setup lang="ts">
import { ref } from 'vue'
import { Menu } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Sheet, SheetContent } from '@/client/ui/sheet'
import SessionList from '@/client/components/session-list.vue'
import { useSyncStore } from '@/client/stores/sync'

defineProps<{ bootError?: string | null }>()

const sync = useSyncStore()
const drawerOpen = ref(false)
</script>

<template lang="pug">
.flex.h-dvh.w-full.overflow-hidden.bg-background.text-foreground
  //- Spec §8: the sidebar column is fixed-height; `SessionList` names its own scroller.
  aside.hidden.w-72.shrink-0.overflow-hidden.border-r.flex-col(class="md:flex")
    SessionList
  Sheet(v-model:open="drawerOpen")
    //- Spec §7.1: the sheet's absolutely positioned close button lands on top of the sidebar
    //- header's own controls, so it is turned off and 关闭 is rendered in the header's normal flow.
    SheetContent(side="left" class="w-72 p-0" :show-close-button="false")
      SessionList(:closable="true" @navigate="drawerOpen = false" @close="drawerOpen = false")
  .flex.min-w-0.flex-1.flex-col
    header.flex.h-12.shrink-0.items-center.gap-2.border-b.px-4
      Button(variant="ghost" size="icon" class="md:hidden" @click="drawerOpen = true")
        Menu(class="size-5")
      #page-header.flex.min-w-0.flex-1.items-center.gap-2
    p.shrink-0.border-b.px-3.py-2.text-xs(v-if="bootError" class="bg-destructive/10 text-destructive") 加载失败，请刷新重试：{{ bootError }}
    //- Spec §11: a rejected WS command must surface instead of silently doing nothing.
    p.flex.shrink-0.items-center.gap-2.border-b.px-3.py-2.text-xs(v-if="sync.lastError" class="bg-destructive/10 text-destructive")
      span 操作失败：{{ sync.lastError }}
      button.ml-auto.underline(@click="sync.lastError = null") 关闭
    //- Spec §8: the route region is fixed-height and clips; every page owns its own scroller.
    .min-h-0.flex-1.overflow-hidden
      slot
</template>
