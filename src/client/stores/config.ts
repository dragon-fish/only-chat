import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import type { Model, Provider } from '@/shared/models'

export const useConfigStore = defineStore('config', () => {
  const providers = ref<Provider[]>([])
  const modelsByProvider = ref<Record<number, Model[]>>({})
  const loaded = ref(false)

  async function load(): Promise<void> {
    providers.value = await api.providers()
    const entries = await Promise.all(providers.value.map(async (p) => [p.id, await api.models(p.id)] as const))
    modelsByProvider.value = Object.fromEntries(entries)
    loaded.value = true
  }

  function enabledModels(): Array<{ provider: Provider; model: Model }> {
    return providers.value.filter((p) => p.enabled).flatMap((provider) =>
      (modelsByProvider.value[provider.id] ?? []).filter((m) => m.enabled).map((model) => ({ provider, model })))
  }

  return { providers, modelsByProvider, loaded, load, enabledModels }
})
