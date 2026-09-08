// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, watch } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { toast, type Action } from 'vue-sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProviderEditor from '@/client/views/settings-provider-edit.vue'
import { api } from '@/client/lib/api'
import { useConfigStore } from '@/client/stores/config'
import type { ModelPage, ModelWithMetadata, ProviderWithInterfaces } from '@/shared/models'
import { catalogStatus, modelRecords, provider } from './provider-fixtures'

const desktop = ref(true)
vi.mock('@vueuse/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@vueuse/core')>(),
  useMediaQuery: () => desktop,
}))

const models = modelRecords
let cleanup = () => {}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function mountEditor() {
  desktop.value = true
  vi.spyOn(api, 'providers').mockResolvedValue([provider])
  vi.spyOn(api, 'queryModels').mockImplementation(async query => ({ models: structuredClone(models).filter(model => !query?.search || `${model.model_id} ${model.metadata.name}`.toLowerCase().includes(query.search.toLowerCase())), next_cursor: null }))
  vi.spyOn(api, 'catalogStatus').mockResolvedValue(catalogStatus)
  vi.spyOn(api, 'catalogProviders').mockResolvedValue([{ id: 'acme', name: 'Acme', api: 'https://acme.test/v1' }])
  const pinia = createPinia()
  await useConfigStore(pinia).load()
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/settings/providers/:id', component: ProviderEditor, props: route => ({ providerId: Number('id' in route.params ? route.params.id : undefined) }) },
    { path: '/settings/providers', component: { template: '<div>Providers</div>' } },
    { path: '/elsewhere', component: { template: '<div>Elsewhere</div>' } },
  ] })
  await router.push('/settings/providers/1')
  document.body.innerHTML = '<header id="page-header"></header><main id="test-host"></main>'
  const app = createApp({ render: () => h(RouterView) }).use(pinia).use(router)
  app.mount('#test-host')
  cleanup = () => app.unmount()
  await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 First model"]')).not.toBeNull())
  return { router, config: useConfigStore(pinia) }
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function delayModelSave() {
  const persisted = structuredClone(models)
  let acknowledge!: () => void
  let reject!: (error: Error) => void
  vi.mocked(api.queryModels).mockImplementation(async query => ({ models: structuredClone(persisted).filter(model => !query?.search || `${model.model_id} ${model.metadata.name}`.toLowerCase().includes(query.search.toLowerCase())), next_cursor: null }))
  const write = vi.spyOn(api, 'updateModel').mockImplementation(async (_providerId, modelId, patch) => {
    await new Promise<void>((resolve, fail) => { acknowledge = resolve; reject = fail })
    const model = persisted.find(model => model.id === modelId)!
    Object.assign(model, patch)
    model.metadata = { ...model.metadata, ...patch.metadata_override } as ModelWithMetadata['metadata']
    return structuredClone(model)
  })
  return { write, acknowledge: () => acknowledge(), reject: () => reject(new Error('Save rejected')) }
}

async function submitModelName() {
  document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
  await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
  const name = document.querySelector<HTMLInputElement>('#model-1-2-name')!
  await type(name, 'Submitted model')
  name.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await nextTick()
}

async function pendingAcknowledgementAcrossAssociation() {
  const { config, router } = await mountEditor()
  const secondProvider = { ...provider, id: 2, name: 'Second provider' }
  const secondModel = { ...models[0]!, id: 20, provider_id: 2, metadata: { name: 'Other provider model' } }
  config.providerRecords.push(secondProvider)
  let persistedProvider = provider
  let persisted = models.map(model => ({ ...model, metadata: { ...model.metadata, description: 'Association A', limit: { context: 1000 } } }))
  vi.mocked(api.providers).mockImplementation(async () => [persistedProvider, secondProvider])
  vi.mocked(api.queryModels).mockImplementation(async query => ({
    models: query?.provider_id === 2 ? [secondModel] : structuredClone(persisted).filter(model => !query?.search || `${model.model_id} ${model.metadata.name}`.toLowerCase().includes(query.search.toLowerCase())),
    next_cursor: null,
  }))
  vi.spyOn(api, 'modelByRef').mockImplementation(async reference => {
    const model = persisted.find(model => model.provider_id === reference.provider_id && model.model_id === reference.model_id)
    if (!model) throw new Error('Unknown model reference')
    return structuredClone(model)
  })
  await config.ensureModel(models[0]!)
  let commitProvider!: () => void
  vi.spyOn(api, 'updateProvider').mockImplementation(async (_id, input) => {
    await new Promise<void>(resolve => { commitProvider = resolve })
    persistedProvider = { ...provider, models_dev_provider_id: 'acme', interfaces: [{ ...provider.interfaces[0]!, base_url: input.interfaces[0]!.base_url }] }
    persisted = persisted.map(model => ({ ...model, metadata: { ...model.metadata, description: 'Association B', limit: { context: 200000 } } }))
    return persistedProvider
  })
  let releaseModel!: () => void
  const write = vi.spyOn(api, 'updateModel').mockImplementation(async (_id, modelId, patch) => {
    const model = persisted.find(model => model.id === modelId)!
    Object.assign(model, patch)
    Object.assign(model.metadata, patch.metadata_override)
    const committedUnderA = structuredClone(model)
    await new Promise<void>(resolve => { releaseModel = resolve })
    return committedUnderA
  })
  await type(document.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!, 'First model')
  await vi.waitFor(() => expect(config.modelsByRef['1:first-model']?.metadata.description).toBe('Association A'))
  await type(document.querySelector<HTMLInputElement>('[data-interface-url]')!, 'https://acme.test/v1')
  document.querySelector('#provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(commitProvider).toBeTypeOf('function'))
  await submitModelName()
  await vi.waitFor(() => expect(releaseModel).toBeTypeOf('function'))
  commitProvider()
  await vi.waitFor(() => expect(config.modelsByRef['1:first-model']?.metadata.description).toBe('Association B'))
  await vi.waitFor(() => expect(document.querySelector('[aria-label="供应商操作"]')?.textContent).not.toContain('保存中'))
  expect(document.querySelectorAll('button[aria-label^="编辑 "]')).toHaveLength(0)
  return { config, router, write, releaseModel, currentModel: () => structuredClone(persisted[0]!) }
}

describe('provider model editor', () => {
  it.each(['filter', 'provider'] as const)('refreshes an exact off-page model after an old association acknowledgement across a %s change', async context => {
    const { config, router, releaseModel, currentModel } = await pendingAcknowledgementAcrossAssociation()
    if (context === 'filter') await type(document.querySelector<HTMLInputElement>('#model-1-2-name')!, 'Newer model draft')
    else {
      const navigation = router.push('/settings/providers/2')
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
      ;[...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent?.trim() === '放弃更改')!.click()
      await navigation
      await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 Other provider model"]')).not.toBeNull())
      document.querySelector<HTMLButtonElement>('[aria-label="编辑 Other provider model"]')!.click()
      await vi.waitFor(() => expect(document.querySelector('#model-2-20-name')).not.toBeNull())
      await type(document.querySelector<HTMLInputElement>('#model-2-20-name')!, 'Other provider draft')
    }
    const observed: unknown[] = []
    const stop = watch(() => config.modelsByRef['1:first-model']?.metadata.description, value => observed.push(value), { flush: 'sync' })
    let finishExact!: (value: ModelWithMetadata) => void
    vi.mocked(api.modelByRef).mockImplementationOnce(reference => {
      if (reference.provider_id !== 1 || reference.model_id !== 'first-model') throw new Error('Refreshed the wrong model')
      return new Promise(resolve => { finishExact = resolve })
    })
    releaseModel()
    await vi.waitFor(() => expect(finishExact).toBeTypeOf('function'))
    expect(config.modelsByRef['1:first-model']?.metadata.description).toBe('Association B')
    finishExact(currentModel())
    await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '保存中…')).toBe(false))
    expect(observed).not.toContain('Association A')
    expect(config.modelFor(models[0]!)?.model).toMatchObject({ metadata_override: { name: 'Submitted model' }, metadata: { name: 'Submitted model', description: 'Association B', limit: { context: 200000 } } })
    expect(config.isAvailable(models[0]!)).toBe(true)
    if (context === 'filter') {
      expect(document.querySelector<HTMLInputElement>('#model-1-2-name')?.value).toBe('Newer model draft')
      expect(document.querySelector<HTMLInputElement>('#model-1-2-description')?.placeholder).toBe('Association B')
      expect(document.querySelector('[data-slot="sheet-content"] [role="status"]')?.textContent).toContain('未保存')
      await type(document.querySelector<HTMLInputElement>('#model-1-2-name')!, 'Submitted model')
      const unload = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(unload)
      expect(unload.defaultPrevented).toBe(false)
      expect(document.querySelectorAll('button[aria-label^="编辑 "]')).toHaveLength(0)
    } else {
      expect(document.querySelector<HTMLInputElement>('#provider-name')?.value).toBe('Second provider')
      expect(document.querySelector<HTMLInputElement>('#model-2-20-name')?.value).toBe('Other provider draft')
    }
    stop()
  })

  it('keeps a committed write successful and its metadata retryable when the exact refresh fails', async () => {
    const { config, releaseModel, currentModel, write } = await pendingAcknowledgementAcrossAssociation()
    const warning = vi.spyOn(toast, 'warning')
    vi.mocked(api.modelByRef).mockRejectedValueOnce(new Error('Metadata unavailable'))
    releaseModel()
    await vi.waitFor(() => expect(warning.mock.calls.some(([, options]) => options?.action)).toBe(true))
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).toBeNull())
    expect(config.modelsByRef['1:first-model']?.metadata.description).toBe('Association B')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(false)
    let finishRecovery!: (value: ModelWithMetadata) => void
    vi.mocked(api.modelByRef).mockImplementationOnce(() => new Promise(resolve => { finishRecovery = resolve }))
    const recovery = config.ensureModel(models[0]!)
    expect(finishRecovery).toBeTypeOf('function')
    finishRecovery({ ...currentModel(), metadata: { ...currentModel().metadata, description: 'Recovered association B' } })
    await recovery
    expect(config.modelsByRef['1:first-model']?.metadata.description).toBe('Recovered association B')
    vi.mocked(api.modelByRef).mockResolvedValue({ ...currentModel(), metadata: { ...currentModel().metadata, description: 'Retried association B' } })
    const action = warning.mock.calls.find(([, options]) => options?.action)![1]!.action as Action
    action.onClick(new MouseEvent('click'))
    await vi.waitFor(() => expect(config.modelsByRef['1:first-model']?.metadata.description).toBe('Retried association B'))
    expect(write).toHaveBeenCalledOnce()
    expect(config.isAvailable(models[0]!)).toBe(true)
  })

  it('refreshes rematerialized provider models and off-page selections while preserving newer drafts', async () => {
    const { config } = await mountEditor()
    const foreign = { ...models[0]!, id: 20, provider_id: 2, metadata: { name: 'Unchanged foreign model' } }
    config.providerRecords.push({ ...provider, id: 2 })
    config.retainModels([foreign])
    await config.ensureModel(models[1]!)
    await config.ensureModel(foreign)
    await type(document.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!, 'first')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 Second model"]')).toBeNull())
    let persisted = structuredClone(models)
    vi.mocked(api.queryModels).mockImplementation(async query => ({ models: structuredClone(persisted).filter(model => !query?.search || model.model_id.includes(query.search)), next_cursor: null }))
    vi.spyOn(api, 'modelByRef').mockImplementation(async reference => reference.provider_id === 2
      ? { ...foreign, metadata: { name: 'Foreign metadata must not be refreshed by this save' } }
      : structuredClone(persisted.find(model => model.model_id === reference.model_id)!))
    let acknowledge!: () => void
    vi.spyOn(api, 'updateProvider').mockImplementation(async () => {
      await new Promise<void>(resolve => { acknowledge = resolve })
      persisted = models.map(model => ({ ...model, metadata: { name: `Acme ${model.model_id}`, reasoning: true, limit: { context: 128000 } } }))
      return { ...provider, models_dev_provider_source: 'manual', models_dev_provider_id: 'acme' }
    })
    vi.mocked(api.providers).mockResolvedValue([{ ...provider, models_dev_provider_source: 'manual', models_dev_provider_id: 'acme' }, { ...provider, id: 2 }])
    document.querySelector<HTMLButtonElement>('#provider-association')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.trim() === 'Acme')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('#provider-association')?.textContent).toContain('Acme'))
    document.querySelector('#provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
    await type(document.querySelector<HTMLInputElement>('#provider-name')!, 'Newer provider draft')
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
    await type(document.querySelector<HTMLInputElement>('#model-1-2-name')!, 'Newer model draft')
    acknowledge()
    await vi.waitFor(() => expect(config.modelFor(models[1]!)?.model.metadata).toEqual({ name: 'Acme second-model', reasoning: true, limit: { context: 128000 } }))
    expect(document.querySelector('[aria-label="编辑 Acme first-model"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="编辑 Acme second-model"]')).toBeNull()
    expect(config.modelsByRef['2:first-model']?.metadata.name).toBe('Unchanged foreign model')
    expect(document.querySelector<HTMLInputElement>('#provider-name')?.value).toBe('Newer provider draft')
    expect(document.querySelector<HTMLInputElement>('#model-1-2-name')?.value).toBe('Newer model draft')
    expect(document.querySelector('[data-slot="sheet-content"] [role="status"]')?.textContent).toContain('未保存')
  })

  it.each(['filter', 'provider'] as const)('does not repaint a newer %s after a provider save starts refreshing models', async context => {
    const { router, config } = await mountEditor()
    const secondProvider = { ...provider, id: 2, name: 'Second provider' }
    const currentModel = context === 'filter' ? { ...models[1]!, metadata: { name: 'Current model' } } : { ...models[1]!, id: 20, provider_id: 2, metadata: { name: 'Current model' } }
    config.providerRecords.push(secondProvider)
    vi.mocked(api.providers).mockResolvedValue([provider, secondProvider])
    vi.spyOn(api, 'updateProvider').mockResolvedValue(provider)
    let finishPage!: (page: ModelPage) => void
    vi.mocked(api.queryModels).mockImplementationOnce(() => new Promise(resolve => { finishPage = resolve }))
      .mockResolvedValue({ models: [currentModel], next_cursor: null })
    document.querySelector('#provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(finishPage).toBeTypeOf('function'))
    if (context === 'filter') await type(document.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!, 'second')
    else await router.push('/settings/providers/2')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 Current model"]')).not.toBeNull())
    finishPage({ models: structuredClone(models), next_cursor: 'stale-cursor' })
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('[aria-label="编辑 Current model"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="编辑 First model"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '加载更多模型')).toBe(false)
    expect(config.modelsByRef[`${currentModel.provider_id}:second-model`]?.metadata.name).toBe('Current model')
    expect(document.querySelector<HTMLInputElement>('#provider-name')?.value).toBe(context === 'filter' ? 'Example' : 'Second provider')
  })

  it('invalidates earlier selected and picker reads before refreshing a saved provider', async () => {
    const { config } = await mountEditor()
    await config.ensureModel(models[1]!)
    let finishOldSelection!: (model: ModelWithMetadata) => void
    let finishSelection!: (model: ModelWithMetadata) => void
    vi.spyOn(api, 'modelByRef').mockImplementationOnce(() => new Promise(resolve => { finishOldSelection = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishSelection = resolve }))
    const oldSelection = config.refreshSelectedModels()
    let finishPicker!: (page: ModelPage) => void
    let finishPage!: (page: ModelPage) => void
    vi.mocked(api.queryModels).mockImplementationOnce(() => new Promise(resolve => { finishPicker = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishPage = resolve }))
    const oldPicker = config.loadEnabledModels()
    vi.spyOn(api, 'updateProvider').mockResolvedValue(provider)
    document.querySelector('#provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(finishSelection).toBeTypeOf('function'))
    await vi.waitFor(() => expect(finishPage).toBeTypeOf('function'))
    finishOldSelection({ ...models[1]!, metadata: { name: 'Stale selection' } })
    finishPicker({ models: [{ ...models[0]!, id: 99, model_id: 'uncached-stale-model' }], next_cursor: null })
    await Promise.all([oldSelection, oldPicker])
    expect(config.modelsByRef['1:second-model']?.metadata.name).not.toBe('Stale selection')
    expect(config.modelsByRef['1:uncached-stale-model']).toBeUndefined()
    finishSelection({ ...models[1]!, metadata: { name: 'Fresh selection' } })
    finishPage({ models: [{ ...models[0]!, metadata: { name: 'Fresh page' } }], next_cursor: null })
    await vi.waitFor(() => expect(config.modelsByRef['1:second-model']?.metadata.name).toBe('Fresh selection'))
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 Fresh page"]')).not.toBeNull())
  })

  it('keeps retained rows editable while a provider save is refreshing their metadata', async () => {
    const { config } = await mountEditor()
    let finishPage!: (page: ModelPage) => void
    vi.mocked(api.queryModels).mockImplementationOnce(() => new Promise(resolve => { finishPage = resolve }))
    vi.spyOn(api, 'updateProvider').mockResolvedValue(provider)
    document.querySelector('#provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(finishPage).toBeTypeOf('function'))
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
    await type(document.querySelector<HTMLInputElement>('#model-1-2-name')!, 'Draft during refresh')
    finishPage({ models: [models[0]!], next_cursor: null })
    await vi.waitFor(() => expect(document.querySelector('[aria-label="正在更新模型列表"]')).toBeNull())
    expect(document.querySelector<HTMLInputElement>('#model-1-2-name')?.value).toBe('Draft during refresh')
    vi.spyOn(api, 'modelByRef').mockResolvedValue({ ...models[1]!, metadata: { name: 'Freshly selected off-page model' } })
    await config.ensureModel(models[1]!)
    expect(config.modelsByRef['1:second-model']?.metadata.name).toBe('Freshly selected off-page model')
  })

  it('tombstones only the original model when its delayed delete finishes after another provider opens a confirmation', async () => {
    const { router, config } = await mountEditor()
    const secondProvider = { ...provider, id: 2, name: 'Second provider' }
    const secondModel = { ...models[0]!, id: 20, provider_id: 2, metadata: { name: 'Second provider model' } }
    config.providerRecords.push(secondProvider)
    vi.mocked(api.providers).mockResolvedValue([provider, secondProvider])
    let finishOldPage!: (page: ModelPage) => void
    vi.mocked(api.queryModels).mockImplementationOnce(() => new Promise(resolve => { finishOldPage = resolve }))
      .mockResolvedValue({ models: [secondModel], next_cursor: null })
    const oldPage = config.loadProviderPage(1)
    let finishDelete!: () => void
    vi.spyOn(api, 'deleteModel').mockImplementation(async (providerId, modelId) => {
      if (providerId !== 1 || modelId !== 2) throw new Error('Deleted the wrong model')
      await new Promise<void>(resolve => { finishDelete = resolve })
    })
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-slot="sheet-content"] button')].find(button => button.textContent?.trim() === '删除模型')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent?.trim() === '删除模型')!.click()
    await vi.waitFor(() => expect(finishDelete).toBeTypeOf('function'))
    await router.push('/settings/providers/2')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 Second provider model"]')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 Second provider model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-2-20-name')).not.toBeNull())
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-slot="sheet-content"] button')].find(button => button.textContent?.trim() === '删除模型')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Second provider model'))
    finishDelete()
    await vi.waitFor(() => expect(config.modelsByRef['1:first-model']).toBeUndefined())
    finishOldPage({ models: structuredClone(models), next_cursor: null })
    await oldPage
    expect(config.modelsByRef['1:first-model']).toBeUndefined()
    expect(config.modelsByRef['2:first-model']?.id).toBe(20)
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Second provider model')
    expect(document.querySelector<HTMLInputElement>('#provider-name')?.value).toBe('Second provider')
  })

  it('keeps a reopened pending override dirty and retryable after the save fails', async () => {
    await mountEditor()
    const save = delayModelSave()
    await submitModelName()
    await vi.waitFor(() => expect(save.write).toHaveBeenCalledTimes(1))
    document.querySelector<HTMLInputElement>('#model-1-2-name')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '放弃更改')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).toBeNull())
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 Submitted model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#model-1-2-name')?.value).toBe('Submitted model'))
    save.reject()
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 First model"]')).not.toBeNull())
    await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '保存中…')).toBe(false))
    expect(document.querySelector('[data-slot="sheet-content"] [role="status"]')?.textContent ?? '').toContain('未保存')
    document.querySelector('#model-1-2-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(save.write).toHaveBeenCalledTimes(2))
    expect(save.write.mock.calls[1]).toEqual([1, 2, { metadata_override: { name: 'Submitted model' } }])
    save.acknowledge()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).toBeNull())
    expect(document.querySelector('[aria-label="编辑 Submitted model"]')).not.toBeNull()
  })

  it('saves newer edits by row identity after the first save removes the model from its filtered page', async () => {
    const { config } = await mountEditor()
    const save = delayModelSave()
    await type(document.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!, 'First model')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 First model"]')).not.toBeNull())
    await submitModelName()
    await vi.waitFor(() => expect(save.write).toHaveBeenCalledTimes(1))
    await type(document.querySelector<HTMLInputElement>('#model-1-2-name')!, 'Newer model draft')
    save.acknowledge()
    await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '保存中…')).toBe(false))
    expect(document.querySelectorAll('button[aria-label^="编辑 "]')).toHaveLength(0)
    expect(document.querySelector<HTMLInputElement>('#model-1-2-name')?.value).toBe('Newer model draft')
    document.querySelector('#model-1-2-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(save.write).toHaveBeenCalledTimes(2))
    expect(save.write.mock.calls[1]).toEqual([1, 2, { metadata_override: { name: 'Newer model draft' } }])
    save.acknowledge()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).toBeNull())
    expect(config.modelsByRef['1:first-model']?.metadata.name).toBe('Newer model draft')
  })

  it('does not repaint a newer filter after a save reread waits for provider refresh', async () => {
    await mountEditor()
    vi.spyOn(api, 'updateModel').mockResolvedValue({ ...models[0]!, enabled: false })
    let finishRefresh!: (providers: ProviderWithInterfaces[]) => void
    vi.mocked(api.providers).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve }))
    document.querySelector<HTMLButtonElement>('[aria-label="启用 First model"]')!.click()
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'))
    await type(document.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!, 'second')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 First model"]')).toBeNull())
    finishRefresh([provider])
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('[aria-label="编辑 First model"]')).toBeNull()
    expect(document.querySelector('[aria-label="编辑 Second model"]')).not.toBeNull()
  })

  it('offers only saved interfaces belonging to the model provider', async () => {
    const { config } = await mountEditor()
    const own = { ...provider.interfaces[0]!, id: 11, protocol: 'responses' as const }
    const foreign = { ...provider.interfaces[0]!, id: 99, provider_id: 2, protocol: 'anthropic' as const }
    config.providerRecords = [{ ...provider, interfaces: [...provider.interfaces, own, foreign] }]
    const write = vi.spyOn(api, 'updateModel').mockResolvedValue({ ...models[0]!, interface_id: 11 })
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-interface')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('#model-1-2-interface')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map(option => option.textContent?.trim())).toEqual(['跟随默认 · chat-completions', 'chat-completions', 'responses'])
    options.find(option => option.textContent?.trim() === 'responses')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-interface')?.textContent).toContain('responses'))
    document.querySelector('#model-1-2-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(1, 2, { interface_id: 11 }))
  })

  it('shows effective metadata as inherited, saves only edited overrides, and resets fields and groups', async () => {
    await mountEditor()
    const write = vi.spyOn(api, 'updateModel').mockResolvedValue(models[0]!)
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
    expect(document.querySelector('[data-provider-settings-form]')).not.toBeNull()
    const name = document.querySelector<HTMLInputElement>('#model-1-2-name')!
    expect(name.value).toBe('')
    expect(name.placeholder).toBe('First model')
    expect(document.querySelector('[data-metadata-source="name"]')?.textContent).toContain('继承')
    await type(name, 'Personal name')
    expect(document.querySelector('[data-metadata-source="name"]')?.textContent).toContain('用户覆写')
    document.querySelector<HTMLButtonElement>('[aria-label="恢复 显示名称 默认值"]')!.click()
    await nextTick()
    expect(name.value).toBe('')
    await type(document.querySelector<HTMLInputElement>('#model-1-2-limit-context')!, '0')
    document.querySelector<HTMLButtonElement>('[aria-label="恢复 限制 整组默认值"]')!.click()
    await nextTick()
    expect(document.querySelector<HTMLInputElement>('#model-1-2-limit-context')?.value).toBe('')
    await type(document.querySelector<HTMLInputElement>('#model-1-2-cost-input')!, '0')
    document.querySelector<HTMLButtonElement>('[aria-label="清除价格"]')!.click()
    document.querySelector<HTMLButtonElement>('#model-1-2-tool_call')!.click()
    name.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(1, 2, { metadata_override: { cost: null, tool_call: true } }))
  })

  it('uses structured modality controls instead of exposing field-level JSON editors', async () => {
    await mountEditor()
    const write = vi.spyOn(api, 'updateModel').mockResolvedValue(models[0]!)
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())

    expect(document.querySelector('#model-1-2-modalities-input')).toBeNull()
    expect(document.querySelector('#model-1-2-reasoning_options')).toBeNull()
    const imageOutput = document.querySelector<HTMLButtonElement>('[aria-label="输出模态 image"]')!
    expect(imageOutput).not.toBeNull()
    imageOutput.click()
    await nextTick()
    document.querySelector('#model-1-2-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(1, 2, {
      metadata_override: { modalities: { output: ['text', 'image'] } },
    }))
  })

  it('warns before raw JSON editing and blocks syntax or schema errors from saving', async () => {
    await mountEditor()
    const write = vi.spyOn(api, 'updateModel').mockResolvedValue(models[0]!)
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('[aria-label="查看或编辑原始 JSON"]')!.click()
    await nextTick()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('保存错误的数据可能导致意外问题')
    const raw = document.querySelector<HTMLTextAreaElement>('#model-1-2-raw-json')!
    expect(raw).not.toBeNull()
    await type(raw, '{')
    expect(document.querySelector('[data-raw-json-error]')?.textContent).toContain('JSON 语法错误')
    raw.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(write).not.toHaveBeenCalled()

    await type(raw, '{"modalities":{"input":["spreadsheet"]}}')
    expect(document.querySelector('[data-raw-json-error]')?.textContent).toContain('不符合模型元数据结构')
    raw.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(write).not.toHaveBeenCalled()

    await type(raw, '{"name":"Raw name"}')
    expect(document.querySelector('[data-raw-json-error]')).toBeNull()
    raw.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(1, 2, { metadata_override: { name: 'Raw name' } }))
  })

  it('clears reasoning budget validation when restoring inherited reasoning options', async () => {
    await mountEditor()
    document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('[aria-label="支持思考开关"]')!.click()
    document.querySelector<HTMLButtonElement>('[aria-label="推理强度 low"]')!.click()
    document.querySelector<HTMLButtonElement>('[aria-label="启用推理 Token 预算"]')!.click()
    await nextTick()
    await type(document.querySelector<HTMLInputElement>('#model-1-2-reasoning-budget-min')!, '100')
    await type(document.querySelector<HTMLInputElement>('#model-1-2-reasoning-budget-max')!, '10')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('最小值不能大于最大值')

    document.querySelector<HTMLButtonElement>('[aria-label="恢复 推理选项 整组默认值"]')!.click()
    await nextTick()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[aria-label="支持思考开关"]')?.getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector<HTMLButtonElement>('[aria-label="启用推理 Token 预算"]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('clears an association conflict after a later successful save has no warning', async () => {
    await mountEditor()
    const update = vi.spyOn(api, 'updateProvider').mockImplementationOnce(async (_id, _input, onWarning) => {
      onWarning?.('Conflicting catalog associations')
      return provider
    }).mockResolvedValue(provider)
    const submit = () => document.querySelector('#provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    submit()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Conflicting catalog associations'))
    await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '保存中…')).toBe(false))
    submit()
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Conflicting catalog associations'))
  })

  it('cancels a pending model search and clears its progress when the query becomes too short', async () => {
    await mountEditor()
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!
    vi.mocked(api.queryModels).mockImplementationOnce(() => new Promise(() => {}))
    await type(search, 'pending')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="正在更新模型列表"]')).not.toBeNull())
    await type(search, 'ab')
    expect(document.querySelector('[aria-label="正在更新模型列表"]')).toBeNull()
    expect(document.body.textContent).toContain('搜索模型至少需要 3 个字符')
  })

  it('keeps its saved heading stable while editing interfaces and refreshes catalog metadata without clearing the draft', async () => {
    await mountEditor()
    await type(document.querySelector<HTMLInputElement>('#provider-name')!, 'Unsaved new name')
    await type(document.querySelector<HTMLInputElement>('[data-interface-url]')!, 'https://new.test/v1')
    expect(document.querySelector('#page-header')?.textContent).toContain('Example')
    expect(document.querySelector('#page-header')?.textContent).not.toContain('Unsaved new name')
    vi.spyOn(api, 'refreshCatalog').mockResolvedValue({ instanceId: 'catalog-manual-test' })
    const refreshStatus = vi.spyOn(api, 'catalogRefreshStatus').mockResolvedValue({ status: 'complete' })
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '刷新模型目录')!.click()
    await vi.waitFor(() => expect(api.refreshCatalog).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(refreshStatus).toHaveBeenCalledWith('catalog-manual-test'))
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).not.toContain('正在刷新'))
    expect(document.querySelector<HTMLInputElement>('#provider-name')?.value).toBe('Unsaved new name')
    expect(document.querySelector<HTMLInputElement>('[data-interface-url]')?.value).toBe('https://new.test/v1')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })

  it('adds distinct interfaces, disables Vertex Files, switches defaults and submits one atomic write', async () => {
    await mountEditor()
    const update = vi.spyOn(api, 'updateProvider').mockResolvedValue(provider)
    document.querySelector<HTMLButtonElement>('[aria-label="添加接口"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    expect([...document.querySelectorAll('[role="option"]')].some(option => option.textContent?.trim() === 'OpenAI Chat Completions')).toBe(false)
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.trim() === 'Vertex 兼容')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[data-protocol="vertex-compatible"]')).not.toBeNull())
    await type(document.querySelector<HTMLInputElement>('[data-protocol="vertex-compatible"]')!, 'https://vertex.test/v1')
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Vertex 兼容 Files"]')?.disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[aria-label="默认接口"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.trim() === 'Vertex 兼容')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[aria-label="默认接口"]')?.textContent).toContain('Vertex 兼容'))
    document.querySelector('#provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect(update.mock.calls[0]?.[1]).toMatchObject({ default_protocol: 'vertex-compatible', interfaces: [
      { protocol: 'chat-completions', base_url: 'https://example.com/v1' }, { protocol: 'vertex-compatible', base_url: 'https://vertex.test/v1', native_files: false },
    ] })
  })

  it.each([false, true])('retains newer model edits after a delayed save (reopened=%s)', async (reopen) => {
    // A saved model ID can match a different editor instance, or an instance with a newer draft.
    // Neither acknowledgement may unmount that draft or mark its newer values as saved.
    await mountEditor()
    const save = delayModelSave()
    await submitModelName()
    await vi.waitFor(() => expect(save.write).toHaveBeenCalledWith(1, 2, {
      metadata_override: { name: 'Submitted model' },
    }))
    if (reopen) {
      document.querySelector<HTMLInputElement>('#model-1-2-name')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
      ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '放弃更改')!.click()
      await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).toBeNull())
      document.querySelector<HTMLButtonElement>('[aria-label="编辑 Submitted model"]')!.click()
      await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
    }
    await type(document.querySelector<HTMLInputElement>('#model-1-2-name')!, 'Newer model draft')
    save.acknowledge()
    await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '保存中…')).toBe(false))
    expect(document.querySelector<HTMLInputElement>('#model-1-2-name')?.value).toBe('Newer model draft')
    expect(document.querySelector('[data-slot="sheet-content"] [role="status"]')?.textContent).toContain('未保存')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    await type(document.querySelector<HTMLInputElement>('#model-1-2-name')!, 'Submitted model')
    const cleanUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanUnload)
    expect(cleanUnload.defaultPrevented).toBe(false)
  })

  it('closes the same editor when the acknowledged submission still matches its draft', async () => {
    await mountEditor()
    const save = delayModelSave()
    await submitModelName()
    await vi.waitFor(() => expect(save.write).toHaveBeenCalledTimes(1))
    save.acknowledge()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).toBeNull())
    expect(document.querySelector('[aria-label="编辑 Submitted model"]')).not.toBeNull()
  })

  it('does not clear edits made after the submitted provider snapshot', async () => {
    await mountEditor()
    let acknowledge!: (value: ProviderWithInterfaces) => void
    vi.spyOn(api, 'updateProvider').mockImplementation(() => new Promise(resolve => { acknowledge = resolve }))
    const name = document.querySelector<HTMLInputElement>('#provider-name')!
    await type(name, 'Submitted provider')
    name.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    await type(name, 'Newer unsaved provider')
    acknowledge({ ...provider, name: 'Submitted provider' })
    await vi.waitFor(() => expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '保存中…')).toBe(false))
    expect(name.value).toBe('Newer unsaved provider')
    const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }
    expect(unload()).toBe(true)
    await type(name, 'Submitted provider')
    expect(unload()).toBe(false)
  })

  it('keeps pending model writes bound to the provider that started them', async () => {
    const { router, config } = await mountEditor()
    const secondProvider = { ...provider, id: 2, name: 'Second provider' }
    const secondModel = { ...models[0]!, id: 20, provider_id: 2, metadata: { name: 'Second provider model' } }
    config.providerRecords.push(secondProvider)
    vi.mocked(api.providers).mockResolvedValue([provider, secondProvider])
    vi.mocked(api.queryModels).mockImplementation(async query => ({ models: query?.provider_id === 1 ? structuredClone(models) : [secondModel], next_cursor: null }))
    let finishWrite!: (value: ModelWithMetadata) => void
    const write = vi.spyOn(api, 'updateModel').mockImplementation(() => new Promise(resolve => { finishWrite = resolve }))
    document.querySelector<HTMLButtonElement>('[aria-label="启用 First model"]')!.click()
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(1, 2, { enabled: false }))
    await router.push('/settings/providers/2')
    finishWrite({ ...models[0]!, enabled: false })
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 Second provider model"]')).not.toBeNull())
    await nextTick()
    expect(document.querySelector<HTMLInputElement>('#provider-name')!.value).toBe('Second provider')
    expect(document.querySelector('[aria-label="编辑 First model"]')).toBeNull()
  })

  it('switches from cached provider data without a skeleton and ignores the previous model request', async () => {
    const { router, config } = await mountEditor()
    config.providerRecords.push({ ...provider, id: 2, name: 'Second provider' }, { ...provider, id: 3, name: 'Third provider' })
    let resolveSecond!: (value: ModelPage) => void
    let resolveThird!: (value: ModelPage) => void
    const second = new Promise<ModelPage>(resolve => { resolveSecond = resolve })
    const third = new Promise<ModelPage>(resolve => { resolveThird = resolve })
    vi.mocked(api.queryModels).mockImplementation(query => query?.provider_id === 2 ? second : third)
    await router.push('/settings/providers/2')
    expect(document.querySelector('[aria-label="正在加载供应商"]')).toBeNull()
    expect(document.querySelector<HTMLInputElement>('#provider-name')?.value).toBe('Second provider')
    await router.push('/settings/providers/3')
    resolveThird({ models: [{ ...models[0]!, id: 30, provider_id: 3, metadata: { name: 'Current model' } }], next_cursor: null })
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 Current model"]')).not.toBeNull())
    resolveSecond({ models: [{ ...models[0]!, id: 20, provider_id: 2, metadata: { name: 'Stale model' } }], next_cursor: null })
    await nextTick()
    expect(document.querySelector<HTMLInputElement>('#provider-name')!.value).toBe('Third provider')
    expect(document.querySelector('[aria-label="编辑 Stale model"]')).toBeNull()
  })

  it('retains edits when leaving is cancelled and only discards them after confirmation', async () => {
    const { router } = await mountEditor()
    await type(document.querySelector<HTMLInputElement>('#provider-name')!, 'Unsaved provider')
    const refresh = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(refresh)
    expect(refresh.defaultPrevented).toBe(true)
    const firstLeave = router.push('/elsewhere')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '继续编辑')!.click()
    await firstLeave
    expect(router.currentRoute.value.path).toBe('/settings/providers/1')
    expect(document.querySelector<HTMLInputElement>('#provider-name')!.value).toBe('Unsaved provider')
    const secondLeave = router.push('/elsewhere')
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '放弃更改')!.click()
    await secondLeave
    expect(router.currentRoute.value.path).toBe('/elsewhere')
  })

  it('searches model IDs and display names, including disabled models, without changing the collection', async () => {
    // Filtering only enabled models hides records that settings must still allow users to manage.
    await mountEditor()
    const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]')
    expect(search).not.toBeNull()
    await type(search!, ' SECOND-MODEL ')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 Second model"]')).not.toBeNull())
    expect(document.querySelector('[aria-label="编辑 First model"]')).toBeNull()
    await type(search!, 'first model')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 First model"]')).not.toBeNull())
    expect(document.querySelector('[aria-label="编辑 Second model"]')).toBeNull()
    await type(search!, 'no match')
    await vi.waitFor(() => expect(document.querySelectorAll('button[aria-label^="编辑 "]')).toHaveLength(0))
    const clear = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '清除筛选')
    expect(clear).toBeDefined()
    clear!.click()
    await vi.waitFor(() => expect(document.querySelectorAll('button[aria-label^="编辑 "]')).toHaveLength(2))
    expect(search!.value).toBe('')
  })

  it('retains unsaved fields when its overlay switches between desktop and mobile', async () => {
    // Recreating the model draft with the overlay branch erases input before the user saves it.
    await mountEditor()
    const opener = document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
    await type(document.querySelector<HTMLInputElement>('#model-1-2-name')!, 'Unsaved name')
    document.querySelector<HTMLButtonElement>('#model-1-2-tool_call')!.click()
    await nextTick()
    desktop.value = false
    await vi.waitFor(() => expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull())
    expect(document.querySelector<HTMLInputElement>('#model-1-2-name')!.value).toBe('Unsaved name')
    expect(document.querySelector('#model-1-2-tool_call')!.getAttribute('aria-checked')).toBe('true')
    desktop.value = true
    await vi.waitFor(() => expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull())
    expect(document.querySelector<HTMLInputElement>('#model-1-2-name')!.value).toBe('Unsaved name')
    document.querySelector<HTMLInputElement>('#model-1-2-name')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '放弃更改')!.click()
    await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).toBeNull())
    await vi.waitFor(() => expect(document.activeElement === opener).toBe(true))
  })
})
