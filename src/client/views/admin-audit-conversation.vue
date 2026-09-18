<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import MessageList from '@/client/components/message-list.vue'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { api } from '@/client/lib/api'
import { createAuditContext, provideAuditContext } from '@/client/lib/audit-context'
import { pathToRoot } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Spinner } from '@/client/ui/spinner'
import type { AuditProvider, AuditTranscript } from '@/shared/api'

/** The page keys this view on both ids: the context below is bound to one account for its lifetime. */
const props = defineProps<{ userId: number, conversationId: number }>()
const providers = shallowRef<AuditProvider[]>([])
const transcript = shallowRef<AuditTranscript | null>(null)
const loading = ref(true)
const error = ref('')
provideAuditContext(createAuditContext(props.userId, () => providers.value))

/** The branch the audited user is looking at: the one ending at the conversation's head. */
const path = computed(() => transcript.value
  ? pathToRoot(new Map(transcript.value.messages.map(message => [message.id, message])), transcript.value.conversation.head_message_id)
  : [])

onMounted(async () => {
  try {
    const [loadedProviders, loadedTranscript] = await Promise.all([
      api.auditProviders(props.userId), api.auditTranscript(props.userId, props.conversationId),
    ])
    providers.value = loadedProviders
    transcript.value = loadedTranscript
  } catch { error.value = '无法加载该会话。审计可能未开启，或会话不属于该用户。' }
  finally { loading.value = false }
})
</script>

<template lang="pug">
.flex.h-full.min-h-0.flex-col
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium {{ transcript?.conversation.title || '审计会话' }}
    Badge(variant="outline") 只读 · 用户 {{ userId }}
  .flex.justify-center.py-8(v-if="loading")
    Spinner(aria-label="正在加载会话")
  .mx-auto.w-full.max-w-3xl.p-4(v-else-if="error")
    Alert(variant="destructive")
      AlertTitle 加载失败
      AlertDescription {{ error }}
  .min-h-0.flex-1(v-else-if="path.length")
    MessageList(:messages="path")
  Empty(v-else)
    EmptyHeader
      EmptyTitle 没有消息
      EmptyDescription 这个会话还没有任何消息。
</template>
