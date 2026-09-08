<script setup lang="ts">
import { computed } from 'vue'
import MessageItem from '@/client/components/message-item.vue'
import { useConfigStore } from '@/client/stores/config'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/client/ui/message-scroller'
import type { Message, Project } from '@/shared/models'

const props = defineProps<{
  messages: Message[]
  project?: Project
}>()
const config = useConfigStore()
const streaming = computed(() => props.messages.some(message => message.status === 'streaming'))

const rows = computed(() => props.messages.map((message) => {
  if (message.role !== 'assistant') return { message }
  const actual = message.provider_id !== null && message.model_id !== null
    ? config.modelFor({ provider_id: message.provider_id, model_id: message.model_id })
    : undefined
  const actualModelName = actual?.model.metadata.name ?? message.model_id ?? '助手'
  return {
    message,
    assistantName: props.project?.name ?? actualModelName,
    assistantModelName: props.project && message.model_id !== null ? actualModelName : undefined,
    assistantProviderName: actual?.provider.name ?? actualModelName,
    assistantLabId: actual?.model.lab_id ?? null,
    assistantModelFamily: actual?.model.metadata.family,
  }
}))
</script>

<template lang="pug">
MessageScrollerProvider(:auto-scroll="true" default-scroll-position="last-anchor")
  MessageScroller
    MessageScrollerViewport(class="oc-scroll")
      MessageScrollerContent(:aria-busy="streaming" class="mx-auto w-full max-w-3xl gap-6 px-4 py-5")
        MessageScrollerItem(
          v-for="row in rows" :key="row.message.id" :message-id="String(row.message.id)"
          :scroll-anchor="row.message.role === 'user'")
          MessageItem(
            :message="row.message" :project="project" :assistant-name="row.assistantName"
            :assistant-model-name="row.assistantModelName" :assistant-provider-name="row.assistantProviderName"
            :assistant-lab-id="row.assistantLabId" :assistant-model-family="row.assistantModelFamily")
    MessageScrollerButton(direction="end" class="size-10 md:size-7")
</template>
