import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/client/lib/api'
import { useConfigStore } from '@/client/stores/config'
import { modelRecords, provider } from './provider-fixtures'

afterEach(() => vi.restoreAllMocks())

describe('catalog config cache', () => {
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
    expect(config.modelFor({ provider_id: 1, model_id: 'second-model' })?.model.display_name).toBe('Second model')
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
