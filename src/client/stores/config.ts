import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import { legacyModelView, legacyProviderView } from '@/client/lib/legacy-catalog-ui'
import type { ModelRef } from '@/shared/api'
import type { Model, ModelQuery, ModelWithMetadata, ProviderWithInterfaces } from '@/shared/models'

export const useConfigStore = defineStore('config', () => {
  const providerRecords = ref<ProviderWithInterfaces[]>([])
  const modelsByRef = ref<Record<string, ModelWithMetadata>>({})
  const providers = computed(() => providerRecords.value.map(legacyProviderView))
  const modelsByProvider = computed(() => {
    const grouped: Record<number, Model[]> = {}
    for (const model of Object.values(modelsByRef.value)) (grouped[model.provider_id] ??= []).push(legacyModelView(model))
    return grouped
  })
  const loaded = ref(false)
  const loadError = ref<string | null>(null)
  const pickerRefs = ref<string[]>([])
  const pickerCursor = ref<string | null>(null)
  const pickerLoaded = ref(false)
  const keyFor = (model: ModelRef) => `${model.provider_id}:${model.model_id}`
  let loadToken = 0
  let pickerToken = 0
  const pageTokens = new Map<number, number>()
  const pendingRefs = new Map<string, Promise<void>>()
  const selectedRefs = new Map<string, ModelRef>()
  const revisions = new Map<string, number>()

  function retainModels(models: readonly ModelWithMetadata[]) {
    for (const model of models) {
      const key = keyFor(model)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      modelsByRef.value[key] = model
    }
  }
  function retainRead(models: readonly ModelWithMetadata[], started: ReadonlyMap<string, number>) {
    return models.flatMap(model => {
      const key = keyFor(model)
      if (revisions.get(key) !== started.get(key)) return modelsByRef.value[key] ? [modelsByRef.value[key]!] : []
      retainModels([model])
      return [model]
    })
  }
  function forgetModel(model: ModelRef) {
    revisions.set(keyFor(model), (revisions.get(keyFor(model)) ?? 0) + 1)
    delete modelsByRef.value[keyFor(model)]
    selectedRefs.delete(keyFor(model))
    pendingRefs.delete(keyFor(model))
    pickerRefs.value = pickerRefs.value.filter(key => key !== keyFor(model))
  }
  async function load(): Promise<void> {
    const token = ++loadToken
    loadError.value = null
    try {
      const result = await api.providers()
      if (token !== loadToken) return
      providerRecords.value = result
      const existing = new Set(result.map(provider => provider.id))
      for (const model of Object.values(modelsByRef.value)) if (!existing.has(model.provider_id)) forgetModel(model)
      loaded.value = true
    } catch (error) {
      if (token === loadToken) loadError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
  async function loadEnabledModels(append = false) {
    const token = ++pickerToken
    const started = new Map(revisions)
    const page = await api.queryModels({ enabled: true, limit: 100, ...(append && pickerCursor.value ? { cursor: pickerCursor.value } : {}) })
    if (token !== pickerToken) return
    const records = retainRead(page.models, started)
    pickerRefs.value = [...new Set([...(append ? pickerRefs.value : []), ...records.map(keyFor)])]
    pickerCursor.value = page.next_cursor
    pickerLoaded.value = true
  }
  async function loadProviderPage(providerId: number, query: Partial<ModelQuery> = {}, signal?: AbortSignal) {
    const token = (pageTokens.get(providerId) ?? 0) + 1
    pageTokens.set(providerId, token)
    const started = new Map(revisions)
    const page = await api.queryModels({ ...query, provider_id: providerId }, signal)
    if (pageTokens.get(providerId) === token && !signal?.aborted) return { ...page, models: retainRead(page.models, started) }
    return page
  }
  async function ensureModel(model: ModelRef | null | undefined): Promise<void> {
    if (!model) return
    selectedRefs.set(keyFor(model), { provider_id: model.provider_id, model_id: model.model_id })
    if (modelsByRef.value[keyFor(model)]) return
    const key = keyFor(model)
    const pending = pendingRefs.get(key)
    if (pending) return pending
    const started = revisions.get(key)
    const operation = api.modelByRef(model).then(value => {
      // Saves and tombstones both supersede this read, even if the cache is currently empty.
      if (revisions.get(key) === started && !modelsByRef.value[key]) retainModels([value])
    }).finally(() => { if (pendingRefs.get(key) === operation) pendingRefs.delete(key) })
    pendingRefs.set(key, operation)
    return operation
  }
  async function refreshSelectedModels() {
    await Promise.all([...selectedRefs.values()].map(async model => {
      const started = new Map(revisions)
      retainRead([await api.modelByRef(model)], started)
    }))
  }
  function modelFor(model: ModelRef | null | undefined) {
    if (!model) return undefined
    const provider = providers.value.find(item => item.id === model.provider_id)
    const record = modelsByRef.value[keyFor(model)]
    return provider && record ? { provider, model: legacyModelView(record) } : undefined
  }
  function enabledModels() {
    return pickerRefs.value.flatMap(key => {
      const record = modelsByRef.value[key]
      const entry = record && modelFor(record)
      return entry?.provider.enabled && entry.model.enabled ? [entry] : []
    })
  }
  function isAvailable(model: ModelRef | null | undefined): boolean {
    const found = modelFor(model)
    return found !== undefined && found.provider.enabled && found.model.enabled
  }
  return {
    providerRecords, providers, modelsByRef, modelsByProvider, loaded, loadError, pickerRefs, pickerCursor, pickerLoaded,
    load, loadEnabledModels, loadProviderPage, ensureModel, refreshSelectedModels, retainModels, forgetModel, enabledModels, modelFor, isAvailable,
  }
})
