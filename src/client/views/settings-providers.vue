<script setup lang="ts">
import { ArrowLeftIcon, ServerIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import ProviderNavigation from '@/client/components/provider-navigation.vue'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/client/ui/empty'
</script>

<template lang="pug">
.flex.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header")
    Button(as-child variant="ghost" size="icon" class="size-10 md:hidden")
      RouterLink(to="/settings" aria-label="返回设置")
        ArrowLeftIcon
    span.truncate.text-sm.font-medium 模型服务
  ProviderNavigation(class="w-full md:w-64 md:shrink-0 md:border-r")
  Empty(class="hidden min-w-0 flex-1 md:flex")
    EmptyHeader
      EmptyMedia(variant="icon")
        ServerIcon
      EmptyTitle 配置你的模型服务
      EmptyDescription 选择一个供应商，管理连接与可用模型。
</template>
