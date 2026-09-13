<script setup lang="ts">
import { CircleUserRoundIcon, ImagesIcon, MessageCircleIcon, PlusIcon, SettingsIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/client/ui/button'
</script>

<template>
  <nav
    aria-label="主要导航"
    class="oc-mobile-nav absolute inset-x-0 bottom-0 flex items-center justify-around border-t bg-background px-4 pt-2 md:hidden"
  >
    <Button as-child variant="ghost" class="h-auto min-h-10 min-w-16 flex-col gap-1 py-1">
      <RouterLink to="/chats" active-class="bg-accent text-accent-foreground">
        <MessageCircleIcon />
        <span class="text-xs">聊天</span>
      </RouterLink>
    </Button>
    <Button as-child variant="ghost" class="h-auto min-h-10 min-w-16 flex-col gap-1 py-1">
      <RouterLink to="/images" active-class="bg-accent text-accent-foreground">
        <ImagesIcon />
        <span class="text-xs">图片</span>
      </RouterLink>
    </Button>
    <Button as-child size="icon-lg" class="size-10 rounded-full">
      <RouterLink to="/new" aria-label="开始随心聊">
        <PlusIcon />
      </RouterLink>
    </Button>
    <Button as-child variant="ghost" class="h-auto min-h-10 min-w-16 flex-col gap-1 py-1">
      <RouterLink to="/me" active-class="bg-accent text-accent-foreground">
        <CircleUserRoundIcon />
        <span class="text-xs">我的</span>
      </RouterLink>
    </Button>
    <Button as-child variant="ghost" class="h-auto min-h-10 min-w-16 flex-col gap-1 py-1">
      <RouterLink to="/settings" active-class="bg-accent text-accent-foreground">
        <SettingsIcon />
        <span class="text-xs">设置</span>
      </RouterLink>
    </Button>
  </nav>
</template>
