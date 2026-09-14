<script setup lang="ts">
import WorkspaceFilePanel from '@/client/components/workspace-file-panel.vue'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'

/** The files tab of the workspace panel: the existing file panel, scoped to the open conversation. */
defineProps<{
  conversationId: number | null
  projectId: number | null
}>()
</script>

<template lang="pug">
.oc-scroll.h-full.overflow-y-auto.px-4.py-4(v-if="conversationId !== null")
  WorkspaceFilePanel(mount="conversation" :scope-id="conversationId")
Empty(v-else class="h-full")
  EmptyHeader
    EmptyTitle 还没有文件
    EmptyDescription 发送第一条消息后，这次会话和它的 Project 里的文件会显示在这里。
</template>
