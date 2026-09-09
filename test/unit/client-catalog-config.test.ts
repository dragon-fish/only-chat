import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/client/lib/api'
import { useConfigStore } from '@/client/stores/config'
import { modelRecords, provider } from './provider-fixtures'

afterEach(() => vi.restoreAllMocks())

describe('catalog config cache', () => {
  it('loads complete cached summaries without issuing paginated model queries', async () => {
    const active = vi.spyOn(api, 'enabledModelSummary').mockResolvedValue({ models: modelRecords })
    const providerModels = vi.spyOn(api, 'providerModelSummary').mockResolvedValue({ models: modelRecords })
    const paginated = vi.spyOn(api, 'queryModels')
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]

    await config.loadEnabledModelList()
    expect(active).toHaveBeenCalledOnce()
    expect(config.enabledModels().map(entry => entry.model.model_id)).toEqual(['first-model'])
    expect(await config.loadProviderModelList(1)).toEqual(modelRecords)
    expect(providerModels).toHaveBeenCalledWith(1, undefined)
    expect(paginated).not.toHaveBeenCalled()
  })

  it('does not retain a provider summary superseded by cache invalidation', async () => {
    const config = useConfigStore(createPinia())
    let finishOld!: (value: { models: typeof modelRecords }) => void
    vi.spyOn(api, 'providerModelSummary').mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce({ models: [{ ...modelRecords[0]!, metadata: { name: 'Current summary' } }] })
    const old = config.loadProviderModelList(1)
    config.invalidateProviderModels(1)
    await config.loadProviderModelList(1)
    finishOld({ models: [{ ...modelRecords[0]!, metadata: { name: 'Stale summary' } }] })
    await old
    expect(config.modelListByRef['1:first-model']?.metadata.name).toBe('Current summary')
  })

  it('does not let an older full-record read overwrite an accepted provider summary', async () => {
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]
    config.retainModels([modelRecords[0]!])
    let finish!: (value: typeof modelRecords[number]) => void
    vi.spyOn(api, 'modelByRef').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    vi.spyOn(api, 'providerModelSummary').mockResolvedValue({ models: [{ ...modelRecords[0]!, metadata: { name: 'Current summary' } }] })
    const old = config.refreshModel(modelRecords[0]!)
    await config.loadProviderModelList(1)
    finish({ ...modelRecords[0]!, metadata: { name: 'Stale full record' } })
    await expect(old).rejects.toThrow()
    expect(config.modelFor(modelRecords[0]!)?.model.metadata.name).toBe('Current summary')
    expect(config.modelsByRef['1:first-model']?.metadata.name).not.toBe('Stale full record')
  })

  it('makes a fresh provider summary canonical over stale full-record list fields', async () => {
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]
    config.retainModels([modelRecords[0]!])
    vi.spyOn(api, 'enabledModelSummary').mockResolvedValue({ models: [modelRecords[0]!] })
    vi.spyOn(api, 'providerModelSummary').mockResolvedValue({ models: [{ ...modelRecords[0]!, enabled: false }] })
    await config.loadEnabledModelList()
    expect(config.enabledModels()).toHaveLength(1)
    await config.loadProviderModelList(1)
    expect(config.enabledModels()).toEqual([])
    expect(config.modelFor(modelRecords[0]!)?.model.enabled).toBe(false)
  })

  it('does not make an absent selected record available after an enabled snapshot loads', async () => {
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]
    config.retainModels([modelRecords[0]!])
    vi.spyOn(api, 'enabledModelSummary').mockResolvedValue({ models: [] })
    await config.loadEnabledModelList()
    expect(config.modelFor(modelRecords[0]!)).toBeDefined()
    expect(config.enabledModels([modelRecords[0]!])).toEqual([])
    expect(config.isAvailable(modelRecords[0]!)).toBe(false)
  })

  it('replaces provider summary membership, pruning deleted rows and adding newly enabled rows', async () => {
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]
    config.retainModels(modelRecords)
    vi.spyOn(api, 'enabledModelSummary').mockResolvedValue({ models: [modelRecords[0]!] })
    vi.spyOn(api, 'providerModelSummary').mockResolvedValue({ models: [{ ...modelRecords[1]!, enabled: true }] })
    await config.loadEnabledModelList()
    await config.loadProviderModelList(1)
    expect(config.modelFor(modelRecords[0]!)).toBeUndefined()
    expect(config.enabledModels().map(entry => entry.model.model_id)).toEqual(['second-model'])
  })

  it('tombstones a stale model when its authoritative by-ref read returns 404', async () => {
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]
    config.retainModels([modelRecords[0]!])
    config.invalidateProviderModels(1)
    vi.spyOn(api, 'modelByRef').mockRejectedValue(new ApiError(404, 'not found', 'GET', '/models/by-ref'))
    await expect(config.ensureModel(modelRecords[0]!)).rejects.toThrow()
    expect(config.modelFor(modelRecords[0]!)).toBeUndefined()
  })

  // A same-session provider refresh supersedes metadata, not the committed rename's old-key cleanup.
  it('removes a renamed model reference after same-generation provider invalidation', () => {
    const config = useConfigStore(createPinia())
    const model = modelRecords[0]!
    config.retainModels([model])
    const acknowledge = config.beginModelWrite(model)
    config.invalidateProviderModels(model.provider_id)

    const retained = acknowledge({ ...model, model_id: 'renamed-model' })

    expect(retained).toBe(false)
    expect(config.modelsByRef['1:first-model']).toBeUndefined()
    expect(config.modelsByRef['1:renamed-model']).toBeUndefined()
  })

  // A rename acknowledgment from an old authenticated identity must not mutate the new cache at all.
  it('rejects renamed model cleanup after the auth generation changes', () => {
    const config = useConfigStore(createPinia())
    const model = modelRecords[0]!
    const acknowledge = config.beginModelWrite(model)
    config.reset()
    config.retainModels([{ ...model, metadata: { name: 'Current user model' } }])

    const retained = acknowledge({ ...model, model_id: 'renamed-model' })

    expect(retained).toBe(false)
    expect(config.modelsByRef['1:first-model']?.metadata.name).toBe('Current user model')
    expect(config.modelsByRef['1:renamed-model']).toBeUndefined()
  })

  it('fences obsolete write metadata and an exact refresh overtaken by another provider revision', async () => {
    const config = useConfigStore(createPinia())
    const model = modelRecords[0]!
    config.retainModels([model])
    const acknowledge = config.beginModelWrite(model)
    config.invalidateProviderModels(1)
    config.retainModels([{ ...model, metadata: { name: 'Association B' } }])
    acknowledge({ ...model, metadata: { name: 'Obsolete association A' } })
    expect(config.modelsByRef['1:first-model']?.metadata.name).toBe('Association B')
    let finish!: (value: typeof model) => void
    vi.spyOn(api, 'modelByRef').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = config.refreshModel(model)
    config.invalidateProviderModels(1)
    config.retainModels([{ ...model, metadata: { name: 'Association C' } }])
    finish({ ...model, metadata: { name: 'Superseded association B' } })
    expect((await pending).metadata.name).toBe('Association C')
    expect(config.modelsByRef['1:first-model']?.metadata.name).toBe('Association C')
  })

  it('keeps a tombstone when a committed-write metadata refresh completes after deletion', async () => {
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]
    const model = modelRecords[0]!
    config.retainModels([model])
    let finish!: (value: typeof model) => void
    vi.spyOn(api, 'modelByRef').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = config.refreshModel(model)
    config.forgetModel(model)
    finish(model)
    await expect(pending).rejects.toThrow()
    expect(config.modelsByRef['1:first-model']).toBeUndefined()
    expect(config.isAvailable(model)).toBe(false)
  })

  it('serializes false, zero, raw Lab IDs, and interface filters into the server query', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ models: [], next_cursor: null })))
    await api.queryModels({ vision: false, reasoning: true, tools: true, image_output: true, interface_id: 10, lab_id: 'lab/name', min_context: 0, search: 'human name' })
    const url = new URL(String(fetcher.mock.calls[0]![0]), 'https://only.chat')
    expect(Object.fromEntries(url.searchParams)).toEqual({ vision: 'false', reasoning: 'true', tools: 'true', image_output: 'true', interface_id: '10', lab_id: 'lab/name', min_context: '0', search: 'human name' })
  })
  it('does not resurrect a forgotten model from an earlier selected-reference request', async () => {
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]
    let finish!: (model: typeof modelRecords[number]) => void
    vi.spyOn(api, 'modelByRef').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const reference = { provider_id: 1, model_id: 'first-model' }
    const pending = config.ensureModel(reference)
    config.forgetModel(reference)
    finish(modelRecords[0]!)
    await pending
    expect(config.modelsByRef['1:first-model']).toBeUndefined()
    expect(config.isAvailable(reference)).toBe(false)
  })

  it('refreshes explicitly selected models even when they are outside the enabled page', async () => {
    const config = useConfigStore(createPinia())
    vi.spyOn(api, 'modelByRef').mockResolvedValueOnce(modelRecords[1]!).mockResolvedValueOnce({ ...modelRecords[1]!, metadata: { name: 'Refreshed selected model' } })
    await config.ensureModel({ provider_id: 1, model_id: 'second-model' })
    await config.refreshSelectedModels()
    expect(config.modelsByRef['1:second-model']?.metadata.name).toBe('Refreshed selected model')
  })

  it('restarts an invalidated selected-reference read without letting the earlier response seed the cache', async () => {
    const config = useConfigStore(createPinia())
    let finishOld!: (model: typeof modelRecords[number]) => void
    let finishCurrent!: (model: typeof modelRecords[number]) => void
    vi.spyOn(api, 'modelByRef').mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishCurrent = resolve }))
    const reference = { provider_id: 1, model_id: 'first-model' }
    const old = config.ensureModel(reference)
    config.invalidateProviderModels(1)
    const current = config.ensureModel(reference)
    finishOld(modelRecords[0]!)
    await old
    expect(config.modelsByRef['1:first-model']).toBeUndefined()
    finishCurrent({ ...modelRecords[0]!, metadata: { name: 'Current selection' } })
    await current
    expect(config.modelsByRef['1:first-model']?.metadata.name).toBe('Current selection')
  })

  it('loads providers independently and retains an explicitly selected disabled model across summaries', async () => {
    vi.spyOn(api, 'providers').mockResolvedValue([provider])
    vi.spyOn(api, 'enabledModelSummary').mockResolvedValue({ models: [modelRecords[0]!] })
    vi.spyOn(api, 'providerModelSummary').mockResolvedValue({ models: modelRecords })
    vi.spyOn(api, 'modelByRef').mockResolvedValue(modelRecords[1]!)
    const config = useConfigStore(createPinia())
    await config.load()
    await config.ensureModel({ provider_id: 1, model_id: 'second-model' })
    await config.loadEnabledModelList()
    await config.loadProviderModelList(1)
    expect(config.modelFor({ provider_id: 1, model_id: 'second-model' })?.model.metadata.name).toBe('Second model')
    expect(config.isAvailable({ provider_id: 1, model_id: 'second-model' })).toBe(false)
    expect(config.enabledModels().map(entry => entry.model.model_id)).toEqual(['first-model'])
  })

})
