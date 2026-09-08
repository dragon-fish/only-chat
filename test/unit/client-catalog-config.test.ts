import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/client/lib/api'
import { useConfigStore } from '@/client/stores/config'
import { codexProvider, modelRecords, provider } from './provider-fixtures'
import type { ProviderWithInterfaces } from '@/shared/models'

afterEach(() => vi.restoreAllMocks())

describe('catalog config cache', () => {
  it.each(['scoped', 'full'] as const)('keeps a newer scoped provider refresh when the older full read finishes %s', async first => {
    const config = useConfigStore(createPinia())
    const connected = { ...codexProvider, id: 1 }
    const disconnected = { ...connected, oauth: { ...connected.oauth, status: 'disconnected' as const, access_expires_at: null } }
    const initialOther = { ...provider, id: 2, name: 'Initial other' }
    const refreshedOther = { ...provider, id: 2, name: 'Refreshed other' }
    config.providerRecords = [connected, initialOther]
    let finishFull!: (value: ProviderWithInterfaces[]) => void
    let finishScoped!: (value: ProviderWithInterfaces[]) => void
    vi.spyOn(api, 'providers').mockImplementationOnce(() => new Promise(resolve => { finishFull = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishScoped = resolve }))
    const full = config.load()
    const scoped = config.refreshProvider(connected.id)

    if (first === 'scoped') {
      finishScoped([disconnected, initialOther])
      await scoped
      finishFull([connected, refreshedOther])
      await full
    } else {
      finishFull([connected, refreshedOther])
      await full
      finishScoped([disconnected, initialOther])
      await scoped
    }

    expect(config.providerRecords).toEqual([disconnected, refreshedOther])
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

  it('aborts a stale filtered request, appends the current cursor, and retains the selected off-page model', async () => {
    const config = useConfigStore(createPinia())
    config.providerRecords = [provider]
    config.retainModels([modelRecords[1]!])
    let finish!: (value: { models: typeof modelRecords; next_cursor: string | null }) => void
    const pages = vi.spyOn(api, 'queryModels').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = config.loadEnabledModels(false, { search: 'first' })
    const signal = pages.mock.calls[0]![1]
    pages.mockResolvedValueOnce({ models: [modelRecords[0]!], next_cursor: 'next' })
    await config.loadEnabledModels(false, { vision: true, min_context: 0, lab_id: 'deepseek' })
    expect(signal?.aborted).toBe(true)
    pages.mockResolvedValueOnce({ models: [{ ...modelRecords[0]!, id: 20, model_id: 'appended' }], next_cursor: null })
    await config.loadEnabledModels(true, { vision: true, min_context: 0, lab_id: 'deepseek' })
    expect(pages.mock.calls[2]![0]).toMatchObject({ enabled: true, vision: true, min_context: 0, lab_id: 'deepseek', cursor: 'next' })
    finish({ models: [], next_cursor: 'stale' })
    await old
    expect(config.enabledModels().map(entry => entry.model.model_id)).toEqual(['first-model', 'appended'])
    expect(config.pickerCursor).toBeNull()
    expect(config.modelFor({ provider_id: 1, model_id: 'second-model' })?.model.metadata.name).toBe('Second model')
    pages.mockResolvedValueOnce({ models: [], next_cursor: null })
    await config.loadEnabledModels(false, { tools: true })
    expect(config.enabledModels()).toEqual([])
    expect(config.modelsByRef['1:second-model']).toBeDefined()
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

  it('does not replace a saved model with a page response that started before the save', async () => {
    const config = useConfigStore(createPinia())
    let finish!: (value: { models: typeof modelRecords; next_cursor: null }) => void
    vi.spyOn(api, 'queryModels').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const old = config.loadProviderPage(1)
    config.retainModels([{ ...modelRecords[0]!, metadata: { name: 'Saved model' } }])
    finish({ models: modelRecords, next_cursor: null })
    await old
    expect(config.modelsByRef['1:first-model']?.metadata.name).toBe('Saved model')
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

  it('loads providers independently and retains an explicitly selected disabled model across model pages', async () => {
    vi.spyOn(api, 'providers').mockResolvedValue([provider])
    const pages = vi.spyOn(api, 'queryModels').mockResolvedValue({ models: [modelRecords[0]!], next_cursor: 'next' })
    vi.spyOn(api, 'modelByRef').mockResolvedValue(modelRecords[1]!)
    const config = useConfigStore(createPinia())
    await config.load()
    expect(pages).not.toHaveBeenCalled()
    await config.ensureModel({ provider_id: 1, model_id: 'second-model' })
    await config.loadEnabledModels()
    pages.mockResolvedValue({ models: [], next_cursor: null })
    await config.loadProviderPage(1)
    expect(config.modelFor({ provider_id: 1, model_id: 'second-model' })?.model.metadata.name).toBe('Second model')
    expect(config.isAvailable({ provider_id: 1, model_id: 'second-model' })).toBe(false)
    expect(config.enabledModels().map(entry => entry.model.model_id)).toEqual(['first-model'])
  })

  it('does not let a superseded provider page overwrite cached metadata', async () => {
    const config = useConfigStore(createPinia())
    let finish!: (value: { models: typeof modelRecords; next_cursor: null }) => void
    const pages = vi.spyOn(api, 'queryModels').mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const old = config.loadProviderPage(1)
    pages.mockResolvedValue({ models: [{ ...modelRecords[0]!, metadata: { name: 'Current' } }], next_cursor: null })
    await config.loadProviderPage(1)
    finish({ models: modelRecords, next_cursor: null })
    await old
    expect(config.modelsByRef['1:first-model']?.metadata.name).toBe('Current')
  })
})
