<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import { NetworkIcon } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/client/ui/dialog'
import { Skeleton } from '@/client/ui/skeleton'

/**
 * Vue Flow, dagre and their d3 dependencies are only fetched the first time the map is opened —
 * a chat that never opens it downloads none of it.
 */
const ConversationMap = defineAsyncComponent({
  loader: () => import('@/client/components/conversation-map.vue'),
  loadingComponent: Skeleton,
})

const props = defineProps<{ conversationId: number | null }>()
const emit = defineEmits<{ locate: [messageId: number] }>()
const open = ref(false)

/** Locating means "go read that message", so the map gets out of the way first. */
function onLocate(messageId: number) {
  open.value = false
  emit('locate', messageId)
}
</script>

<template lang="pug">
Dialog(v-if="props.conversationId !== null" v-model:open="open")
  DialogTrigger(as-child)
    Button(
      variant="ghost" size="icon-xs" class="min-h-10 min-w-10 md:min-h-6 md:min-w-6"
      title="分支地图" aria-label="分支地图")
      NetworkIcon
  DialogContent(class="flex h-[85dvh] max-h-[85dvh] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl" @escape-key-down="open = false")
    DialogHeader(class="px-4 pt-4")
      DialogTitle(class="text-sm") 分支地图
      DialogDescription(class="text-xs") 单击节点切换分支，双击定位到该消息。
    .min-h-0.flex-1
      ConversationMap(
        v-if="open" :conversation-id="props.conversationId"
        @locate="onLocate")
</template>
