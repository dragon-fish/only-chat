import { ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { conversationPath } from '@/client/lib/ui-models'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'

export function useConversationFork() {
  const sync = useSyncStore()
  const router = useRouter()
  const requestId = ref<string | null>(null)
  watchEffect(() => {
    const id = requestId.value
    if (!id) return
    const result = sync.forkResult
    const conversationId = result?.request_id === id ? result.conversation_id : undefined
    const conversation = conversationId === undefined ? undefined : sync.conversations.get(conversationId)
    if (!conversation) return
    requestId.value = null
    void router.push(conversationPath(conversation))
  })
  watch(() => sync.lastError, error => { if (error !== null) requestId.value = null })
  function fork(conversationId: number, messageId: number) {
    if (requestId.value) return
    const id = crypto.randomUUID()
    requestId.value = id
    sync.lastError = null
    if (!sync.send({ type: 'conversation.fork', request_id: id, conversation_id: conversationId, message_id: messageId })) {
      requestId.value = null
      sync.lastError = DISCONNECTED_MESSAGE
    }
  }
  return { pending: requestId, fork }
}
