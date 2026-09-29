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

const selectedRecord = { ...modelRecords[0]!, model_id: 'test-model', metadata: { name: 'Test model', tool_call: false, modalities: { input: ['text' as const, 'image' as const], output: ['text' as const] } } }

async function mountPicker(compact: boolean, isDesktop: boolean, summary: typeof modelRecords | Error = [selectedRecord], retainSelected = true) {
  vi.spyOn(api, 'catalogProviders').mockResolvedValue([])
  const summaries = vi.spyOn(api, 'enabledModelSummary')
  if (summary instanceof Error) summaries.mockRejectedValueOnce(summary)
  else summaries.mockResolvedValue({ models: summary })
  desktop.value = isDesktop
  const pinia = createPinia()
  const config = useConfigStore(pinia)
  config.loaded = true
  config.providerRecords = [provider]
  config.pickerLoaded = false
  if (retainSelected) config.retainModels([selectedRecord])
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
  it('filters the complete cached summary locally', async () => {
    const remote = { ...modelRecords[1]!, enabled: true, metadata: { name: 'Remote reasoning model', reasoning: true } }
    const host = await mountPicker(false, true, [selectedRecord, remote])
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')!
    expect(input.closest('[data-slot="input-group"]')?.querySelector('[aria-label="筛选模型"]')).not.toBeNull()
    input.value = 'remote'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('Remote reasoning model'))
    document.querySelector<HTMLButtonElement>('[aria-label="筛选模型"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[aria-label="推理"]')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('[aria-label="推理"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('Remote reasoning model'))
    expect(host.textContent).toContain('Test model')
  })

  it('keeps enabled-model retry and selection usable when the selected reference returns 404', async () => {
    vi.spyOn(api, 'modelByRef').mockRejectedValue(new Error('GET selected model failed: 404 not found'))
    const host = await mountPicker(false, true, new Error('Enabled model query offline'), false)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Enabled model query offline'))
    vi.mocked(api.enabledModelSummary).mockResolvedValue({ models: [modelRecords[0]!] })
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '重试')!.click()
    await vi.waitFor(() => expect([...document.querySelectorAll('[role="option"]')].some(option => option.textContent?.includes('First model'))).toBe(true))
    document.querySelector<HTMLElement>('[role="option"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).toBeNull())
  })

  it('reloads enabled membership when reopened after settings changed', async () => {
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('Test model'))
    document.querySelector('[data-slot="command-input"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).toBeNull())
    vi.mocked(api.enabledModelSummary).mockResolvedValue({ models: [{ ...modelRecords[0]!, id: 99, model_id: 'new-model', metadata: { name: 'Newly enabled model' } }] })
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect([...document.querySelectorAll('[role="option"]')].some(option => option.textContent?.includes('Newly enabled model'))).toBe(true))
  })

  it('names the selected provider on the trigger', async () => {
    const host = await mountPicker(false, true)
    await vi.waitFor(() => expect(host.querySelector('button')?.textContent?.replace(/\s+/g, '')).toMatch(/Testmodel\(Example\)$/))
  })

  it('keeps the selected model visible in the complete enabled summary', async () => {
    const retained = { ...modelRecords[1]!, enabled: true, model_id: 'test-model', metadata: { name: 'Retained selection' } }
    vi.spyOn(api, 'modelByRef').mockResolvedValue(retained)
    const host = await mountPicker(false, true, [modelRecords[0]!, retained], false)
    await vi.waitFor(() => expect(host.textContent).toContain('Retained selection'))
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect([...document.querySelectorAll('[role="option"]')].some(option => option.textContent?.includes('First model'))).toBe(true))
    expect([...document.querySelectorAll('[role="option"]')].some(option => option.textContent?.includes('Retained selection'))).toBe(true)
    expect(host.textContent).toContain('Retained selection')
  })

  it('reveals the active model after the picker page renders', async () => {
    const revealed: string[] = []
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      revealed.push(this.textContent ?? '')
    })
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(revealed.some(text => text.includes('Test model'))).toBe(true))
  })

  it('reveals declared capabilities on hover while keeping the option compact', async () => {
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    const option = document.querySelector<HTMLElement>('[role="option"]')!
    expect(option.querySelector('[role="img"][aria-label="图片输入"]')).not.toBeNull()
    expect(option.querySelector('[role="img"][aria-label="工具"]')).toBeNull()
    option.closest('[data-slot=hover-card-trigger]')!.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))
    await vi.waitFor(() => expect(document.querySelector('[data-model-details]')).not.toBeNull())
    const badges = [...document.querySelectorAll('[data-model-details] [data-slot="badge"]')].map(badge => badge.textContent?.trim())
    expect(badges).toEqual(['图片输入'])
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

  it('saves the whole provider when API address changes are applied from quick settings', async () => {
    const update = vi.spyOn(api, 'updateProvider').mockResolvedValue(provider)
    vi.spyOn(api, 'providers').mockResolvedValue([provider])
    const host = await mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('[aria-label="设置供应商 Example"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('编辑供应商'))
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'API 地址配置')!.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-interface-url]')).not.toBeNull())
    const endpoint = document.querySelector<HTMLInputElement>('[data-interface-url]')!
    endpoint.value = 'https://quick-settings.test/v1'
    endpoint.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '应用')!.click()

    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(1, expect.objectContaining({
      interfaces: [expect.objectContaining({ base_url: 'https://quick-settings.test/v1' })],
    }), expect.any(Function)))
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

it('opens mobile model details without selecting or closing the picker', async () => {
  const host = await mountPicker(false, false)
  host.querySelector<HTMLButtonElement>('button')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
  expect(document.querySelector('[role="option"]')!.textContent).not.toContain('test-model')
  const info = document.querySelector<HTMLButtonElement>('[aria-label="查看 Test model 详情"]')
  expect(info).not.toBeNull()
  info!.click()
  await nextTick()
  await vi.waitFor(() => expect(document.querySelector('[data-model-details]')?.textContent).toContain('test-model'))
  expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull()
  expect(document.querySelector('[role="option"]')).not.toBeNull()
})
