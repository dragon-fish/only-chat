import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import type { ModelRef } from '@/shared/api'
import type { Model, Provider } from '@/shared/models'

export const useConfigStore = defineStore('config', () => {
  const providers = ref<Provider[]>([])
  const modelsByProvider = ref<Record<number, Model[]>>({})
  const loaded = ref(false)
  const loadError = ref<string | null>(null)

  async function load(): Promise<void> {
    loadError.value = null
    try {
      providers.value = await api.providers()
      const entries = await Promise.all(providers.value.map(async (p) => [p.id, await api.models(p.id)] as const))
      modelsByProvider.value = Object.fromEntries(entries)
      loaded.value = true
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  function enabledModels(): Array<{ provider: Provider; model: Model }> {
    return providers.value.filter((p) => p.enabled).flatMap((provider) =>
      (modelsByProvider.value[provider.id] ?? []).filter((m) => m.enabled).map((model) => ({ provider, model })))
  }

  /**
   * Looks a reference up regardless of `enabled`: a Project default or session override may point
   * at a model that was since disabled, and the UI has to say so rather than silently drop it.
   */
  function modelFor(ref: ModelRef | null | undefined): { provider: Provider; model: Model } | undefined {
    if (!ref) return undefined
    const provider = providers.value.find((p) => p.id === ref.provider_id)
    const model = provider && modelsByProvider.value[provider.id]?.find((m) => m.model_id === ref.model_id)
    return provider && model ? { provider, model } : undefined
  }

  function isAvailable(ref: ModelRef | null | undefined): boolean {
    const found = modelFor(ref)
    return found !== undefined && found.provider.enabled && found.model.enabled
  }

  return { providers, modelsByProvider, loaded, loadError, load, enabledModels, modelFor, isAvailable }
})
