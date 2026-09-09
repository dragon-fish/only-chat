import { ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { authClient, type AuthSession, type AuthUser } from '@/client/lib/auth-client'

export const useAuthStore = defineStore('auth', () => {
  const authSession = shallowRef<AuthSession | null>(null)
  const authUser = shallowRef<AuthUser | null>(null)
  const ready = ref(false)
  const generation = ref(0)
  watch(() => authSession.value ? `${authSession.value.user.id}:${authSession.value.session.id}` : null,
    () => { generation.value++ }, { flush: 'sync' })
  let refreshEpoch = 0
  let pendingRefresh: Promise<void> | null = null

  function clear(): void {
    refreshEpoch++
    pendingRefresh = null
    authSession.value = null
    authUser.value = null
    ready.value = true
  }

  function refresh(force = false): Promise<void> {
    if (!force && pendingRefresh) return pendingRefresh
    const epoch = ++refreshEpoch
    const operation = (async () => {
      try {
        const result = await authClient.getSession()
        if (epoch !== refreshEpoch) return pendingRefresh ?? undefined
        authSession.value = result.data
        authUser.value = result.data?.user ?? null
      } catch {
        if (epoch !== refreshEpoch) return pendingRefresh ?? undefined
        authSession.value = null
        authUser.value = null
      } finally {
        if (epoch === refreshEpoch) ready.value = true
      }
    })()
    pendingRefresh = operation
    void operation.finally(() => { if (pendingRefresh === operation) pendingRefresh = null })
    return operation
  }

  async function signOut(): Promise<void> {
    const result = await authClient.signOut()
    if (result.error) throw new Error(result.error.message || 'Sign out failed')
    clear()
  }

  return { authSession, authUser, ready, generation, refresh, signOut, clear }
})
