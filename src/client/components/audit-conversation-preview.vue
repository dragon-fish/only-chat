<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { useOverlayLeave } from '@/client/composables/use-route-overlay'
import MessageList from '@/client/components/message-list.vue'
import { api } from '@/client/lib/api'
import { createAuditContext, provideAuditContext } from '@/client/lib/audit-context'
import { pathToRoot } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Spinner } from '@/client/ui/spinner'
import type { AuditProviderRow, AuditTranscript } from '@/shared/api'

/** The listing keys this on the id: the context below is bound to one conversation's owner. */
const props = defineProps<{ conversationId: number }>()
/** `leave` fires once the exit animation is over; the listing then drops `?preview` from the URL. */
const emit = defineEmits<{ leave: [] }>()
const { open, setOpen } = useOverlayLeave(() => emit('leave'))
const providers = shallowRef<AuditProviderRow[]>([])
const transcript = shallowRef<AuditTranscript | null>(null)
const loading = ref(true)
const error = ref('')
provideAuditContext(createAuditContext(() => providers.value))

/** The branch the audited user is looking at: the one ending at the conversation's head. */
const path = computed(() => transcript.value
  ? pathToRoot(new Map(transcript.value.messages.map(message => [message.id, message])), transcript.value.conversation.head_message_id)
  : [])

onMounted(async () => {
  try {
    const loaded = await api.auditTranscript(props.conversationId)
    // Model names resolve against the owner's providers; without them the raw model id still shows.
    providers.value = (await api.auditProviders({ user: String(loaded.owner.id), limit: '500' }).catch(() => null))?.rows ?? []
    transcript.value = loaded
  } catch { error.value = '无法加载该会话。审计可能未开启，或会话不存在。' }
  finally { loading.value = false }
})
</script>

<template lang="pug">
ResponsiveOverlay(
  mode="dialog" :open="open" :title="transcript?.conversation.title || '会话预览'"
  @update:open="setOpen")
  template(#status)
    Badge(v-if="transcript" variant="outline") 只读 · {{ transcript.owner.name }}
  .flex.justify-center.py-8(v-if="loading")
    Spinner(aria-label="正在加载会话")
  Alert(v-else-if="error" variant="destructive")
    AlertTitle 加载失败
    AlertDescription {{ error }}
  //- MessageList scrolls itself, so it needs a bounded height inside the overlay's own scroller.
  div(v-else-if="path.length" class="-mx-4 h-[calc(100dvh-7rem)] md:h-[70dvh]")
    MessageList(:messages="path")
  Empty(v-else)
    EmptyHeader
      EmptyTitle 没有消息
      EmptyDescription 这个会话还没有任何消息。
</template>
