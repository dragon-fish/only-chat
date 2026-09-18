<script setup lang="ts">
import { computed, ref } from 'vue'
import MessageItem from '@/client/components/message-item.vue'
import MessageOutline from '@/client/components/message-outline.vue'
import MessageRail from '@/client/components/message-rail.vue'
import { messageTurns } from '@/client/lib/message-turns'
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
import type { EffectiveModel } from '@/client/stores/sync'
import { projectPresentation } from '@/client/lib/ui-models'
import { useAuditContext, type AuditModel } from '@/client/lib/audit-context'
import type { ModelRef } from '@/shared/api'

const props = defineProps<{
  messages: Message[]
  project?: Project
  optimisticId?: number | null
  effectiveModel?: EffectiveModel
}>()
const config = useConfigStore()
const scroller = ref<{ scrollToMessage: (messageId: string) => boolean } | null>(null)

/** Lets the conversation map jump to a message: the scroller API lives inside this subtree. */
defineExpose({ scrollToMessage: (messageId: number) => scroller.value?.scrollToMessage(String(messageId)) ?? false })
/** Navigation only earns its place once there is somewhere to go. */
const turns = computed(() => messageTurns(props.messages))
const streaming = computed(() => props.messages.some(message => message.status === 'streaming'))

const audit = useAuditContext()
/** An audited transcript names models from the audited account's providers, not the viewer's. */
function modelInfo(model: ModelRef): AuditModel | undefined {
  if (audit) return audit.resolveModel(model)
  const actual = config.modelFor(model)
  return actual && { name: actual.model.metadata.name ?? null, providerName: actual.provider.name, labId: actual.model.lab_id, family: actual.model.metadata.family ?? null }
}

const rows = computed(() => props.messages.map((message) => {
  const optimistic = props.optimisticId === message.id
  if (message.role !== 'assistant') return { message, optimistic }
  const actual = message.provider_id !== null && message.model_id !== null
    ? modelInfo({ provider_id: message.provider_id, model_id: message.model_id })
    : undefined
  const actualModelName = actual?.name ?? message.model_id ?? '助手'
  return {
    message,
    optimistic,
    assistantName: props.project ? projectPresentation(props.project.name).title : actualModelName,
    assistantModelName: props.project && message.model_id !== null ? actualModelName : undefined,
    assistantProviderName: actual?.providerName ?? actualModelName,
    assistantLabId: actual?.labId ?? null,
    assistantModelFamily: actual?.family ?? undefined,
  }
}))
</script>

<template lang="pug">
//- auto-scroll off: a reply must not drag the viewport along as it streams. peek 0: a new turn goes
//- to the very top, since a sliver of the previous reply left hanging there reads as a mis-scroll.
//- Opening a conversation lands at the end — "last-anchor" only made sense while auto-scroll was
//- there to carry on past it, and on its own it stops at the last question, mid-reply.
MessageScrollerProvider(
  ref="scroller" :auto-scroll="false" :scroll-previous-item-peek="0"
  default-scroll-position="end")
  MessageScroller
    MessageScrollerViewport(class="oc-scroll")
      MessageScrollerContent(:aria-busy="streaming" class="mx-auto w-full max-w-3xl gap-6 px-4 py-5")
        MessageScrollerItem(
          v-for="row in rows" :key="row.message.id" :message-id="String(row.message.id)"
          :scroll-anchor="row.message.role === 'user'")
          MessageItem(
            :message="row.message" :project="project" :assistant-name="row.assistantName"
            :effective-model="effectiveModel"
            :optimistic="row.optimistic"
            :assistant-model-name="row.assistantModelName" :assistant-provider-name="row.assistantProviderName"
            :assistant-lab-id="row.assistantLabId" :assistant-model-family="row.assistantModelFamily")
    MessageScrollerButton(direction="end" class="size-10 md:size-7")
    template(v-if="turns.length >= 2")
      MessageRail(:turns="turns")
      MessageOutline(:turns="turns")
</template>
