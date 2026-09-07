// @vitest-environment happy-dom
import { createApp, ref } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ModelPicker from '@/client/components/model-picker.vue'
import { useConfigStore } from '@/client/stores/config'

const desktop = ref(false)
vi.mock('@vueuse/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@vueuse/core')>(),
  useMediaQuery: () => desktop,
}))

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mountPicker(compact: boolean, isDesktop: boolean) {
  desktop.value = isDesktop
  const pinia = createPinia()
  const config = useConfigStore(pinia)
  config.loaded = true
  config.providers = [{ id: 1, user_id: 1, name: 'Example', protocol: 'openai-completions', base_url: '', enabled: true, has_key: false, native_files: false, extra: null, created_at: 0 }]
  config.modelsByProvider = { 1: [{ id: 1, provider_id: 1, model_id: 'test-model', display_name: 'Test model', capabilities: { vision: true, tools: false }, enabled: true, pricing: null, sort: 0 }] }
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(ModelPicker, { compact, modelValue: { provider_id: 1, model_id: 'test-model' } }).use(pinia)
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}

describe('model picker modality', () => {
  it('shows only declared true capabilities on each selectable model', async () => {
    // Dropping capability presentation or treating a declared false flag as enabled mislabels models.
    const host = mountPicker(false, true)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    const badges = [...document.querySelectorAll('[role="option"] [data-slot="badge"]')].map(badge => badge.textContent?.trim())
    expect(badges).toEqual(['视觉'])
  })

  it.each([false, true])('opens a mobile Drawer for either trigger appearance (compact=%s)', async (compact) => {
    // Project settings uses the full trigger on phones; compact must not choose the focus surface.
    const host = mountPicker(compact, false)
    host.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
  })

  it('moves one open picker through breakpoint changes and restores its current trigger on close', async () => {
    // Two independent open states can leave a hidden Popover live or resurrect it after resizing.
    const host = mountPicker(false, true)
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
