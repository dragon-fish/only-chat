import { ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { sessionPath } from '@/client/lib/ui-models'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'

export function useSessionFork() {
  const sync = useSyncStore()
  const router = useRouter()
  const requestId = ref<string | null>(null)
  watchEffect(() => {
    const id = requestId.value
    if (!id) return
    const result = sync.forkResult
    const sessionId = result?.request_id === id ? result.session_id : undefined
    const session = sessionId === undefined ? undefined : sync.sessions.get(sessionId)
    if (!session) return
    requestId.value = null
    void router.push(sessionPath(session))
  })
  watch(() => sync.lastError, error => { if (error !== null) requestId.value = null })
  function fork(sessionId: number, messageId: number) {
    if (requestId.value) return
    const id = crypto.randomUUID()
    requestId.value = id
    sync.lastError = null
    if (!sync.send({ type: 'session.fork', request_id: id, session_id: sessionId, message_id: messageId })) {
      requestId.value = null
      sync.lastError = DISCONNECTED_MESSAGE
    }
  }
  return { pending: requestId, fork }
}
