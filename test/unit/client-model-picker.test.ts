// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ModelPicker from '@/client/components/model-picker.vue'
import { useConfigStore } from '@/client/stores/config'
import { api } from '@/client/lib/api'
import { modelRecords, provider } from './provider-fixtures'

const desktop = ref(false)
vi.mock('@vueuse/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@vueuse/core')>(),
  useMediaQuery: () => desktop,
}))

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

async function mountPicker(compact: boolean, isDesktop: boolean, loaded = true) {
  vi.spyOn(api, 'catalogProviders').mockResolvedValue([])
  desktop.value = isDesktop
  const pinia = createPinia()
  const config = useConfigStore(pinia)
  config.loaded = true
  config.providerRecords = [provider]
  config.pickerLoaded = loaded
  if (loaded) {
    const records = [{ ...modelRecords[0]!, model_id: 'test-model', metadata: { name: 'Test model', tool_call: false, modalities: { input: ['text' as const, 'image' as const], output: ['text' as const] } } }]
    config.retainModels(records)
    vi.spyOn(api, 'queryModels').mockResolvedValue({ models: records, next_cursor: null })
    config.pickerRefs = ['1:test-model']
  }
  const host = document.createElement('div')
  document.body.append(host)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { render: () => h(ModelPicker, { compact, modelValue: { provider_id: 1, model_id: 'test-model' } }) } },
    { path: '/settings/providers/:id', component: { template: '<div />' } },
  ] })
  await router.push('/')
  const app = createApp({ render: () => h(RouterView) }).use(pinia).use(router)
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}

describe('model picker modality', () => {
  it('sends search and capability filters to the server and shows models outside the initial page', async () => {
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    const remote = { ...modelRecords[1]!, enabled: true, metadata: { name: 'Remote reasoning model', reasoning: true } }
    vi.mocked(api.queryModels).mockResolvedValue({ models: [remote], next_cursor: null })
    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')!
    input.value = 'remote'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(vi.mocked(api.queryModels).mock.calls.at(-1)?.[0]).toMatchObject({ search: 'remote' }))
    document.querySelector<HTMLButtonElement>('[aria-label="推理"]')!.click()
    await vi.waitFor(() => expect(vi.mocked(api.queryModels).mock.calls.at(-1)?.[0]).toMatchObject({ search: 'remote', reasoning: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('Remote reasoning model'))
    expect(host.textContent).toContain('Test model')
  })

  it('keeps enabled-model retry and selection usable when the selected reference returns 404', async () => {
    vi.spyOn(api, 'modelByRef').mockRejectedValue(new Error('GET selected model failed: 404 not found'))
    const query = vi.spyOn(api, 'queryModels').mockRejectedValueOnce(new Error('Enabled model query offline'))
    const host = await mountPicker(false, true, false)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Enabled model query offline'))
    query.mockResolvedValue({ models: [modelRecords[0]!], next_cursor: null })
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '重试')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('First model'))
    document.querySelector<HTMLElement>('[role="option"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).toBeNull())
  })

  it('reloads enabled membership when reopened after settings changed', async () => {
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('Test model'))
    document.querySelector('[data-slot="command-input"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).toBeNull())
    vi.mocked(api.queryModels).mockResolvedValue({ models: [{ ...modelRecords[0]!, id: 99, model_id: 'new-model', metadata: { name: 'Newly enabled model' } }], next_cursor: null })
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('Newly enabled model'))
  })

  it('loads a selected model outside the enabled page and keeps it renderable', async () => {
    vi.spyOn(api, 'modelByRef').mockResolvedValue({ ...modelRecords[1]!, model_id: 'test-model', metadata: { name: 'Retained selection' } })
    vi.spyOn(api, 'queryModels').mockResolvedValue({ models: [modelRecords[0]!], next_cursor: null })
    const host = await mountPicker(false, true, false)
    await vi.waitFor(() => expect(host.textContent).toContain('Retained selection'))
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('First model'))
    expect(host.textContent).toContain('Retained selection')
  })

  it('shows only declared true capabilities on each selectable model', async () => {
    // Dropping capability presentation or treating a declared false flag as enabled mislabels models.
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    const badges = [...document.querySelectorAll('[role="option"] [data-slot="badge"]')].map(badge => badge.textContent?.trim())
    expect(badges).toEqual(['视觉'])
  })

  it('opens the matching provider in a quick settings dialog and saves without changing the selected model', async () => {
    const updated = { ...provider, name: 'Renamed provider' }
    const update = vi.spyOn(api, 'updateProvider').mockResolvedValue(updated)
    vi.spyOn(api, 'providers').mockResolvedValue([updated])
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    const settings = document.querySelector<HTMLButtonElement>('[aria-label="设置供应商 Example"]')
    expect(settings).not.toBeNull()
    settings!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('编辑供应商'))
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === '打开完整设置')).toBe(true)

    const name = document.querySelector<HTMLInputElement>('#quick-provider-1-name')!
    name.value = 'Renamed provider'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    name.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Renamed provider', api_key: undefined }), expect.any(Function)))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(host.querySelector('button')?.getAttribute('aria-label')).toContain('Test model')
  })

  it.each([false, true])('opens a mobile Drawer for either trigger appearance (compact=%s)', async (compact) => {
    // Project settings uses the full trigger on phones; compact must not choose the focus surface.
    const host = await mountPicker(compact, false)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
  })

  it('moves one open picker through breakpoint changes and restores its current trigger on close', async () => {
    // Two independent open states can leave a hidden Popover live or resurrect it after resizing.
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.focus()
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull())
    desktop.value = false
    await vi.waitFor(() => expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')!
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    const trigger = host.querySelector<HTMLButtonElement>('button')!
    await vi.waitFor(() => expect(document.activeElement === trigger).toBe(true))
    desktop.value = true
    await vi.waitFor(() => expect(host.querySelector('button')!.getAttribute('aria-expanded')).toBe('false'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
