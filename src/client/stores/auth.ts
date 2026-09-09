import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { authClient, type AuthSession, type AuthUser } from '@/client/lib/auth-client'

export const useAuthStore = defineStore('auth', () => {
  const authSession = shallowRef<AuthSession | null>(null)
  const authUser = shallowRef<AuthUser | null>(null)
  const ready = ref(false)

  function clear(): void {
    authSession.value = null
    authUser.value = null
  }

  async function refresh(): Promise<void> {
    try {
      const result = await authClient.getSession()
      authSession.value = result.data
      authUser.value = result.data?.user ?? null
    } catch {
      clear()
    } finally {
      ready.value = true
    }
  }

  async function signOut(): Promise<void> {
    const result = await authClient.signOut()
    if (result.error) throw new Error(result.error.message || 'Sign out failed')
    clear()
  }

  return { authSession, authUser, ready, refresh, signOut, clear }
})
