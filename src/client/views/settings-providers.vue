<script setup lang="ts">
import { ServerIcon } from '@lucide/vue'
import ProviderNavigation from '@/client/components/provider-navigation.vue'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/client/ui/empty'
</script>

<template lang="pug">
.flex.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 模型服务
  ProviderNavigation(class="w-full md:w-64 md:shrink-0 md:border-r")
  Empty(class="hidden min-w-0 flex-1 md:flex")
    EmptyHeader
      EmptyMedia(variant="icon")
        ServerIcon
      EmptyTitle 配置你的模型服务
      EmptyDescription 从 models.dev 选择供应商或配置自定义端点，管理接口与已添加模型。
</template>
