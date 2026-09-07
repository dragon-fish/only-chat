// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
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

async function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function delayModelSave() {
  const persisted = structuredClone(models)
  let acknowledge!: () => void
  vi.mocked(api.queryModels).mockImplementation(async () => ({ models: structuredClone(persisted), next_cursor: null }))
  const write = vi.spyOn(api, 'updateModel').mockImplementation(async (_providerId, modelId, patch) => {
    await new Promise<void>(resolve => { acknowledge = resolve })
    const model = persisted.find(model => model.id === modelId)!
    Object.assign(model, patch)
    model.metadata = { ...model.metadata, ...patch.metadata_override } as ModelWithMetadata['metadata']
    return structuredClone(model)
  })
  return { write, acknowledge: () => acknowledge() }
}

async function submitModelName() {
  document.querySelector<HTMLButtonElement>('[aria-label="编辑 First model"]')!.click()
  await vi.waitFor(() => expect(document.querySelector('#model-1-2-name')).not.toBeNull())
  const name = document.querySelector<HTMLInputElement>('#model-1-2-name')!
  await type(name, 'Submitted model')
  name.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await nextTick()
}

describe('provider model editor', () => {
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
    vi.spyOn(api, 'refreshCatalog').mockResolvedValue({ version: 'v2', changed: true, providers: 1, globalModels: 1, providerModels: 1 })
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '刷新模型目录')!.click()
    await vi.waitFor(() => expect(api.refreshCatalog).toHaveBeenCalledOnce())
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
      model_id: 'first-model', enabled: true, metadata_override: { name: 'Submitted model' },
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
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 First model"]')).toBeNull())
    expect(document.querySelector('[aria-label="编辑 Second model"]')).not.toBeNull()
    await type(search!, 'first model')
    await vi.waitFor(() => expect(document.querySelector('[aria-label="编辑 First model"]')).not.toBeNull())
    expect(document.querySelector('[aria-label="编辑 Second model"]')).toBeNull()
    await type(search!, 'no match')
    await vi.waitFor(() => expect(document.querySelectorAll('button[aria-label^="编辑 "]')).toHaveLength(0))
    const clear = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '清除搜索')
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
    document.querySelector<HTMLButtonElement>('#model-1-2-tools')!.click()
    await nextTick()
    desktop.value = false
    await vi.waitFor(() => expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull())
    expect(document.querySelector<HTMLInputElement>('#model-1-2-name')!.value).toBe('Unsaved name')
    expect(document.querySelector('#model-1-2-tools')!.getAttribute('aria-checked')).toBe('true')
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
