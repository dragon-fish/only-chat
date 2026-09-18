import { shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import { useAuthStore } from '@/client/stores/auth'
import type { SiteConfig } from '@/shared/auth'

/**
 * One `/api/site-config` request shared by the whole app. The response depends on who asks (the
 * owner sees more), so a different session asks again; `load(true)` is for after a setting changes.
 */
export const useSiteConfigStore = defineStore('siteConfig', () => {
  const auth = useAuthStore()
  const config = shallowRef<SiteConfig | null>(null)
  let loadedFor: number | null = null
  let pending: { generation: number, promise: Promise<SiteConfig> } | null = null

  function load(force = false): Promise<SiteConfig> {
    const generation = auth.generation
    if (!force && config.value && loadedFor === generation) return Promise.resolve(config.value)
    if (!force && pending?.generation === generation) return pending.promise
    const promise = api.siteConfig().then(loaded => {
      if (auth.generation === generation) { config.value = loaded; loadedFor = generation }
      return loaded
    })
    pending = { generation, promise }
    void promise.finally(() => { if (pending?.promise === promise) pending = null }).catch(() => {})
    return promise
  }

  return { config, load }
})
