import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/client/lib/api'
import type { CatalogProviderSummary, ModelRef } from '@/shared/api'
import type { ModelQuery, ModelWithMetadata, ProviderWithInterfaces } from '@/shared/models'

export const useConfigStore = defineStore('config', () => {
  const providerRecords = ref<ProviderWithInterfaces[]>([])
  const modelsByRef = ref<Record<string, ModelWithMetadata>>({})
  const providers = computed(() => providerRecords.value)
  const catalogProviders = ref<CatalogProviderSummary[]>([])
  const modelsByProvider = computed(() => {
    const grouped: Record<number, ModelWithMetadata[]> = {}
    for (const model of Object.values(modelsByRef.value)) (grouped[model.provider_id] ??= []).push(model)
    return grouped
  })
  const loaded = ref(false)
  const loadError = ref<string | null>(null)
  const pickerRefs = ref<string[]>([])
  const pickerCursor = ref<string | null>(null)
  const pickerLoaded = ref(false)
  const pickerLoading = ref(false)
  const pickerError = ref<string | null>(null)
  const keyFor = (model: ModelRef) => `${model.provider_id}:${model.model_id}`
  let loadToken = 0
  let appliedLoadToken = 0
  const providerRefreshTokens = new Map<number, number>()
  let pickerToken = 0
  let pickerController: AbortController | undefined
  let pickerQuery = ''
  const pageTokens = new Map<number, number>()
  const pendingRefs = new Map<string, Promise<void>>()
  const selectedRefs = new Map<string, ModelRef>()
  const revisions = new Map<string, number>()
  const providerRevisions = new Map<number, number>()
  const staleRefs = new Set<string>()

  function readRevisions() {
    return { models: new Map(revisions), providers: new Map(providerRevisions) }
  }

  function retainModels(models: readonly ModelWithMetadata[]) {
    for (const model of models) {
      const key = keyFor(model)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      staleRefs.delete(key)
      modelsByRef.value[key] = model
    }
  }
  function retainRead(models: readonly ModelWithMetadata[], started: ReturnType<typeof readRevisions>) {
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
    // Retain row identities for open editors and queued writes while refreshed metadata is pending.
    for (const [key, model] of Object.entries(modelsByRef.value)) if (model.provider_id === providerId) staleRefs.add(key)
    for (const [key, model] of selectedRefs) if (model.provider_id === providerId) pendingRefs.delete(key)
  }
  function forgetModel(model: ModelRef) {
    revisions.set(keyFor(model), (revisions.get(keyFor(model)) ?? 0) + 1)
    delete modelsByRef.value[keyFor(model)]
    staleRefs.delete(keyFor(model))
    selectedRefs.delete(keyFor(model))
    pendingRefs.delete(keyFor(model))
    pickerRefs.value = pickerRefs.value.filter(key => key !== keyFor(model))
  }
  function beginModelWrite(model: ModelRef) {
    const reference = { provider_id: model.provider_id, model_id: model.model_id }
    const key = keyFor(reference)
    const providerRevision = providerRevisions.get(reference.provider_id)
    const modelRevision = revisions.get(key)
    return (result: ModelWithMetadata) => {
      const current = providerRevisions.get(reference.provider_id) === providerRevision && revisions.get(key) === modelRevision
      if (reference.model_id !== result.model_id) forgetModel(reference)
      // A committed PUT can arrive after a provider save has rematerialized its metadata.
      if (!current) return false
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
    const result = await api.modelByRef(reference)
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
      appliedLoadToken = token
      const existing = new Set(result.map(provider => provider.id))
      for (const model of Object.values(modelsByRef.value)) if (!existing.has(model.provider_id)) forgetModel(model)
      loaded.value = true
    } catch (error) {
      if (token === loadToken) loadError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }
  async function refreshProvider(providerId: number): Promise<void> {
    const token = (providerRefreshTokens.get(providerId) ?? 0) + 1
    providerRefreshTokens.set(providerId, token)
    const loadStarted = loadToken
    const appliedLoadStarted = appliedLoadToken
    const result = await api.providers()
    if (providerRefreshTokens.get(providerId) !== token || loadToken !== loadStarted || appliedLoadToken !== appliedLoadStarted) return
    const current = providerRecords.value.find(provider => provider.id === providerId)
    const refreshed = result.find(provider => provider.id === providerId)
    if (!current || !refreshed) return
    providerRecords.value = providerRecords.value.map(provider => provider.id === providerId ? refreshed : provider)
  }
  async function loadEnabledModels(append = false, query: Partial<ModelQuery> = {}) {
    const token = ++pickerToken
    pickerController?.abort()
    const controller = new AbortController()
    pickerController = controller
    const filters = { ...query, enabled: true, limit: 100, cursor: undefined }
    const queryKey = JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)))
    append = append && queryKey === pickerQuery && pickerCursor.value !== null
    pickerQuery = queryKey
    if (!append) { pickerRefs.value = []; pickerCursor.value = null; pickerLoaded.value = false }
    pickerLoading.value = true
    pickerError.value = null
    const started = readRevisions()
    try {
      const page = await api.queryModels({ ...filters, ...(append ? { cursor: pickerCursor.value! } : {}) }, controller.signal)
      if (token !== pickerToken || controller.signal.aborted) return
      const records = retainRead(page.models, started)
      pickerRefs.value = [...new Set([...(append ? pickerRefs.value : []), ...records.map(keyFor)])]
      pickerCursor.value = page.next_cursor
      pickerLoaded.value = true
    } catch (error) {
      if (token === pickerToken && !controller.signal.aborted) {
        pickerError.value = error instanceof Error ? error.message : String(error)
        throw error
      }
    } finally { if (token === pickerToken) pickerLoading.value = false }
  }
  function cancelPickerQuery() {
    pickerToken++
    pickerController?.abort()
    pickerLoading.value = false
  }
  async function loadCatalogProviders() {
    try { catalogProviders.value = await api.catalogProviders() }
    catch { /* Existing model metadata remains usable when catalog names are unavailable. */ }
  }
  async function loadProviderPage(providerId: number, query: Partial<ModelQuery> = {}, signal?: AbortSignal) {
    const token = (pageTokens.get(providerId) ?? 0) + 1
    pageTokens.set(providerId, token)
    const started = readRevisions()
    const page = await api.queryModels({ ...query, provider_id: providerId }, signal)
    if (pageTokens.get(providerId) === token && !signal?.aborted) return { ...page, models: retainRead(page.models, started) }
    return page
  }
  async function ensureModel(model: ModelRef | null | undefined): Promise<void> {
    if (!model) return
    selectedRefs.set(keyFor(model), { provider_id: model.provider_id, model_id: model.model_id })
    if (modelsByRef.value[keyFor(model)] && !staleRefs.has(keyFor(model))) return
    const key = keyFor(model)
    const pending = pendingRefs.get(key)
    if (pending) return pending
    const started = revisions.get(key)
    const providerStarted = providerRevisions.get(model.provider_id)
    const operation = api.modelByRef(model).then(value => {
      // Saves and tombstones both supersede this read, even if the cache is currently empty.
      if (revisions.get(key) === started && providerRevisions.get(model.provider_id) === providerStarted && (!modelsByRef.value[key] || staleRefs.has(key))) retainModels([value])
    }).finally(() => { if (pendingRefs.get(key) === operation) pendingRefs.delete(key) })
    pendingRefs.set(key, operation)
    return operation
  }
  async function refreshSelectedModels(providerId?: number) {
    await Promise.all([...selectedRefs.values()].filter(model => providerId === undefined || model.provider_id === providerId).map(async model => {
      const started = readRevisions()
      retainRead([await api.modelByRef(model)], started)
    }))
  }
  function modelFor(model: ModelRef | null | undefined) {
    if (!model) return undefined
    const provider = providers.value.find(item => item.id === model.provider_id)
    const record = modelsByRef.value[keyFor(model)]
    const endpoint = provider?.interfaces.find(endpoint => endpoint.id === (record?.interface_id ?? provider.default_interface_id))
    return provider && record ? { provider, model: record, interface: endpoint } : undefined
  }
  function enabledModels(additional: readonly ModelRef[] = []) {
    const keys = [...new Set([...additional.map(keyFor), ...pickerRefs.value])]
    return keys.flatMap(key => {
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
    providerRecords, providers, catalogProviders, modelsByRef, modelsByProvider, loaded, loadError, pickerRefs, pickerCursor, pickerLoaded, pickerLoading, pickerError,
    load, refreshProvider, loadCatalogProviders, loadEnabledModels, cancelPickerQuery, loadProviderPage, ensureModel, refreshSelectedModels, invalidateProviderModels, beginModelWrite, refreshModel, retainModels, forgetModel, enabledModels, modelFor, isAvailable,
  }
})
