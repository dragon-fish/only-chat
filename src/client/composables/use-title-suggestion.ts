import { ref, watch } from 'vue'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'

/**
 * Asks the service model to name one conversation and hands the answer back.
 *
 * Deliberately does not apply it. The button sits in a rename dialog, whose whole purpose is that
 * the user decides what the conversation is called — a suggestion that renamed things by itself
 * would be a different feature wearing this one's clothes.
 */
export function useTitleSuggestion(onTitle: (title: string) => void) {
  const sync = useSyncStore()
  const requestId = ref<string | null>(null)

  watch(() => sync.titleSuggestion, result => {
    if (!result || result.request_id !== requestId.value) return
    requestId.value = null
    if (result.title === null) sync.lastError = '服务模型没能给出名字，可以再试一次'
    else onTitle(result.title)
  })
  watch(() => sync.lastError, error => { if (error !== null) requestId.value = null })

  function suggest(conversationId: number) {
    if (requestId.value) return
    const id = crypto.randomUUID()
    requestId.value = id
    sync.lastError = null
    if (!sync.send({ type: 'conversation.suggest_title', request_id: id, conversation_id: conversationId })) {
      requestId.value = null
      sync.lastError = DISCONNECTED_MESSAGE
    }
  }

  return { pending: requestId, suggest }
}
