import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import type { CatalogProviderSummary, ModelRef } from '@/shared/api'
import type { ModelListItem, ModelWithMetadata, ProviderWithInterfaces } from '@/shared/models'

export const useConfigStore = defineStore('config', () => {
  const providerRecords = ref<ProviderWithInterfaces[]>([])
  const modelsByRef = ref<Record<string, ModelWithMetadata>>({})
  const modelListByRef = ref<Record<string, ModelListItem>>({})
  const providers = computed(() => providerRecords.value)
  const catalogProviders = ref<CatalogProviderSummary[]>([])
  const modelsByProvider = computed(() => {
    const grouped: Record<number, ModelWithMetadata[]> = {}
    for (const model of Object.values(modelsByRef.value)) (grouped[model.provider_id] ??= []).push(model)
    return grouped
  })
  const activeModelRefs = ref<string[]>([])
  let activeListController: AbortController | undefined
  let activeListToken = 0
  const loaded = ref(false)
  const loadError = ref<string | null>(null)
  const pickerLoaded = ref(false)
  const pickerLoading = ref(false)
  const pickerError = ref<string | null>(null)
  const keyFor = (model: ModelRef) => `${model.provider_id}:${model.model_id}`
  const isNotFound = (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 404
  let loadToken = 0
  const providerListTokens = new Map<number, number>()
  const providerMembershipKnown = new Set<number>()
  const pendingRefs = new Map<string, Promise<void>>()
  const selectedRefs = new Map<string, ModelRef>()
  const revisions = new Map<string, number>()
  const providerRevisions = new Map<number, number>()
  const staleRefs = new Set<string>()
  let generation = 0

  function readRevisions() {
    return { generation, models: new Map(revisions), providers: new Map(providerRevisions) }
  }

  function retainModels(models: readonly ModelWithMetadata[]) {
    for (const model of models) {
      const key = keyFor(model)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      staleRefs.delete(key)
      modelsByRef.value[key] = model
      modelListByRef.value[key] = summarize(model)
    }
  }
  function summarize(model: ModelWithMetadata): ModelListItem {
    const { name, family, reasoning, reasoning_options, tool_call, modalities, limit, interleaved } = model.metadata
    return {
      id: model.id, provider_id: model.provider_id, model_id: model.model_id, interface_id: model.interface_id,
      metadata: Object.fromEntries(Object.entries({ name, family, reasoning, reasoning_options, tool_call, modalities, limit, interleaved })
        .filter(([, value]) => value !== undefined)),
      image_extra_body: model.image_extra_body,
      lab_id: model.lab_id, enabled: model.enabled, manual_pinned: model.manual_pinned,
      upstream_available: model.upstream_available, sort: model.sort,
    }
  }
  function retainListItems(models: readonly ModelListItem[]) {
    for (const model of models) modelListByRef.value[keyFor(model)] = model
  }
  function replaceProviderList(providerId: number, models: readonly ModelListItem[]) {
    const retained = new Set(models.map(keyFor))
    const missing = new Map<string, ModelRef>()
    for (const [key, model] of Object.entries(modelListByRef.value)) {
      if (model.provider_id === providerId && !retained.has(key)) missing.set(key, model)
    }
    for (const [key, model] of Object.entries(modelsByRef.value)) {
      if (model.provider_id === providerId && !retained.has(key)) missing.set(key, model)
    }
    for (const model of missing.values()) forgetModel(model)
    retainListItems(models)
    providerMembershipKnown.add(providerId)
    activeModelRefs.value = [
      ...activeModelRefs.value.filter(key => !key.startsWith(`${providerId}:`)),
      ...models.filter(model => model.enabled).map(keyFor),
    ]
  }
  function retainRead(models: readonly ModelWithMetadata[], started: ReturnType<typeof readRevisions>) {
    if (started.generation !== generation) return []
    return models.flatMap(model => {
      const key = keyFor(model)
      if (revisions.get(key) !== started.models.get(key) || providerRevisions.get(model.provider_id) !== started.providers.get(model.provider_id)) {
        return modelsByRef.value[key] ? [modelsByRef.value[key]!] : []
      }
      retainModels([model])
      return [model]
    })
  }
  function invalidateProviderModels(providerId: number) {
    // Association/interface writes rematerialize every model, including uncached rows in old reads.
    providerRevisions.set(providerId, (providerRevisions.get(providerId) ?? 0) + 1)
    providerListTokens.set(providerId, (providerListTokens.get(providerId) ?? 0) + 1)
    // Retain row identities for open editors and queued writes while refreshed metadata is pending.
    for (const [key, model] of Object.entries(modelsByRef.value)) if (model.provider_id === providerId) staleRefs.add(key)
    for (const [key, model] of selectedRefs) if (model.provider_id === providerId) pendingRefs.delete(key)
  }
  function forgetModel(model: ModelRef) {
    revisions.set(keyFor(model), (revisions.get(keyFor(model)) ?? 0) + 1)
    delete modelsByRef.value[keyFor(model)]
    delete modelListByRef.value[keyFor(model)]
    staleRefs.delete(keyFor(model))
    selectedRefs.delete(keyFor(model))
    pendingRefs.delete(keyFor(model))
    activeModelRefs.value = activeModelRefs.value.filter(key => key !== keyFor(model))
  }
  function beginModelWrite(model: ModelRef) {
    const startedGeneration = generation
    const reference = { provider_id: model.provider_id, model_id: model.model_id }
    const key = keyFor(reference)
    const providerRevision = providerRevisions.get(reference.provider_id)
    const modelRevision = revisions.get(key)
    return (result: ModelWithMetadata) => {
      if (generation !== startedGeneration) return false
      const currentMetadata = providerRevisions.get(reference.provider_id) === providerRevision && revisions.get(key) === modelRevision
      // A same-session provider refresh supersedes metadata, but not a committed rename's old key.
      if (reference.model_id !== result.model_id) forgetModel(reference)
      if (!currentMetadata) return false
      retainModels([result])
      return true
    }
  }
  async function refreshModel(model: Pick<ModelWithMetadata, 'id' | 'provider_id' | 'model_id'>) {
    const reference = { provider_id: model.provider_id, model_id: model.model_id }
    const key = keyFor(reference)
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
    staleRefs.add(key)
    pendingRefs.delete(key)
    const started = readRevisions()
    let result: ModelWithMetadata
    try { result = await api.modelByRef(reference) }
    catch (error) {
      if (isNotFound(error) && started.generation === generation
        && started.models.get(key) === revisions.get(key) && started.providers.get(model.provider_id) === providerRevisions.get(model.provider_id)) forgetModel(reference)
      throw error
    }
    if (result.id !== model.id) throw new Error('Model reference changed during metadata refresh')
    const [current] = retainRead([result], started)
    if (!current || current.id !== model.id || staleRefs.has(key)) throw new Error('Model metadata refresh was superseded; retry to load the current metadata')
    return current
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
      for (const providerId of providerMembershipKnown) if (!existing.has(providerId)) providerMembershipKnown.delete(providerId)
      loaded.value = true
    } catch (error) {
      if (token === loadToken) loadError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
  async function loadEnabledModelList() {
    const token = ++activeListToken
    activeListController?.abort()
    const controller = new AbortController()
    activeListController = controller
    pickerLoading.value = true
    pickerError.value = null
    try {
      const snapshot = await api.enabledModelSummary(controller.signal)
      if (token !== activeListToken || controller.signal.aborted) return
      retainListItems(snapshot.models)
      activeModelRefs.value = snapshot.models.map(keyFor)
      pickerLoaded.value = true
    } catch (error) {
      if (token === activeListToken && !controller.signal.aborted) {
        pickerError.value = error instanceof Error ? error.message : String(error)
        throw error
      }
    } finally { if (token === activeListToken) pickerLoading.value = false }
  }
  function cancelPickerQuery() {
    activeListToken++
    activeListController?.abort()
    pickerLoading.value = false
  }
  async function loadCatalogProviders() {
    const startedGeneration = generation
    try {
      const result = await api.catalogProviders()
      if (startedGeneration === generation) catalogProviders.value = result
    }
    catch { /* Existing model metadata remains usable when catalog names are unavailable. */ }
  }
  async function loadProviderModelList(providerId: number, signal?: AbortSignal) {
    const token = (providerListTokens.get(providerId) ?? 0) + 1
    providerListTokens.set(providerId, token)
    const snapshot = await api.providerModelSummary(providerId, signal)
    if (providerListTokens.get(providerId) === token && !signal?.aborted) {
      providerRevisions.set(providerId, (providerRevisions.get(providerId) ?? 0) + 1)
      for (const [key, model] of Object.entries(modelsByRef.value)) if (model.provider_id === providerId) staleRefs.add(key)
      replaceProviderList(providerId, snapshot.models)
    }
    return snapshot.models
  }
  async function ensureModel(model: ModelRef | null | undefined): Promise<void> {
    if (!model) return
    selectedRefs.set(keyFor(model), { provider_id: model.provider_id, model_id: model.model_id })
    if (modelsByRef.value[keyFor(model)] && !staleRefs.has(keyFor(model))) return
    const key = keyFor(model)
    const startedGeneration = generation
    const pending = pendingRefs.get(key)
    if (pending) return pending
    const started = revisions.get(key)
    const providerStarted = providerRevisions.get(model.provider_id)
    const operation = api.modelByRef(model).then(value => {
      // Saves and tombstones both supersede this read, even if the cache is currently empty.
      if (generation === startedGeneration && revisions.get(key) === started && providerRevisions.get(model.provider_id) === providerStarted && (!modelsByRef.value[key] || staleRefs.has(key))) retainModels([value])
    }).catch(error => {
      if (isNotFound(error)
        && generation === startedGeneration && revisions.get(key) === started
        && providerRevisions.get(model.provider_id) === providerStarted) forgetModel(model)
      throw error
    }).finally(() => { if (pendingRefs.get(key) === operation) pendingRefs.delete(key) })
    pendingRefs.set(key, operation)
    return operation
  }
  async function refreshSelectedModels(providerId?: number) {
    await Promise.all([...selectedRefs.values()].filter(model => providerId === undefined || model.provider_id === providerId).map(async model => {
      const started = readRevisions()
      try { retainRead([await api.modelByRef(model)], started) }
      catch (error) {
        if (isNotFound(error) && started.generation === generation
          && started.models.get(keyFor(model)) === revisions.get(keyFor(model))
          && started.providers.get(model.provider_id) === providerRevisions.get(model.provider_id)) forgetModel(model)
        else throw error
      }
    }))
  }
  function modelFor(model: ModelRef | null | undefined) {
    if (!model) return undefined
    const provider = providers.value.find(item => item.id === model.provider_id)
    const full = modelsByRef.value[keyFor(model)]
    const summary = modelListByRef.value[keyFor(model)]
    const record = full && summary
      ? { ...full, ...summary, metadata: { ...full.metadata, ...summary.metadata } }
      : summary ?? full
    const endpoint = provider?.interfaces.find(endpoint => endpoint.id === (record?.interface_id ?? provider.default_interface_id))
    return provider && record ? { provider, model: record, interface: endpoint } : undefined
  }
  function enabledModels(additional: readonly ModelRef[] = []) {
    const keys = [...new Set([
      ...activeModelRefs.value,
      ...additional.filter(model => !pickerLoaded.value && !providerMembershipKnown.has(model.provider_id)).map(keyFor),
    ])]
    return keys.flatMap(key => {
      const entry = modelFor(modelListByRef.value[key] ?? modelsByRef.value[key])
      return entry?.provider.enabled && entry.model.enabled ? [entry] : []
    })
  }
  function isAvailable(model: ModelRef | null | undefined): boolean {
    const found = modelFor(model)
    if (!found || !found.provider.enabled || !found.model.enabled) return false
    if (!pickerLoaded.value && !providerMembershipKnown.has(found.provider.id)) return true
    return activeModelRefs.value.includes(keyFor(found.model))
  }

  function reset(): void {
    generation++
    loadToken++
    activeListToken++
    activeListController?.abort()
    providerListTokens.clear()
    providerMembershipKnown.clear()
    pendingRefs.clear()
    selectedRefs.clear()
    revisions.clear()
    providerRevisions.clear()
    staleRefs.clear()
    providerRecords.value = []
    modelsByRef.value = {}
    modelListByRef.value = {}
    catalogProviders.value = []
    loaded.value = false
    loadError.value = null
    activeModelRefs.value = []
    pickerLoaded.value = false
    pickerLoading.value = false
    pickerError.value = null
  }
  return {
    providerRecords, providers, catalogProviders, modelsByRef, modelListByRef, modelsByProvider, loaded, loadError, pickerLoaded, pickerLoading, pickerError,
    load, loadCatalogProviders, loadEnabledModelList, cancelPickerQuery, loadProviderModelList, ensureModel, refreshSelectedModels, invalidateProviderModels, beginModelWrite, refreshModel, retainModels, forgetModel, enabledModels, modelFor, isAvailable, reset,
  }
})
