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
  aside.hidden.w-72.shrink-0.border-r.flex-col(class="md:flex")
    SessionList
  Sheet(v-model:open="drawerOpen")
    SheetContent(side="left" class="w-72 p-0")
      SessionList(@navigate="drawerOpen = false")
  .flex.min-w-0.flex-1.flex-col
    header.flex.h-12.items-center.gap-2.border-b.px-3
      Button(variant="ghost" size="icon" class="md:hidden" @click="drawerOpen = true")
        Menu(class="size-5")
      span.text-sm.font-medium only-chat
      span.ml-auto.size-2.rounded-full(:class="sync.status === 'open' ? 'bg-emerald-500' : 'bg-zinc-400'" :title="sync.status")
    p.border-b.px-3.py-2.text-xs(v-if="bootError" class="bg-destructive/10 text-destructive") 加载失败，请刷新重试：{{ bootError }}
    .min-h-0.flex-1
      slot
</template>
