// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'

const desktop = ref(false)
vi.mock('@vueuse/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@vueuse/core')>(),
  useMediaQuery: () => desktop,
}))

let cleanup = () => {}
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function mountOverlay(isDesktop: boolean) {
  desktop.value = isDesktop
  const open = ref(false)
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(defineComponent(() => () => [
    h('button', { onClick: () => { open.value = true } }, 'Edit settings'),
    h(ResponsiveOverlay, {
      open: open.value,
      title: 'Settings',
      'onUpdate:open': (value: boolean) => { open.value = value },
    }, {
      default: () => h('input', { 'aria-label': 'Draft' }),
      footer: () => h('button', { onClick: () => { open.value = false } }, 'Save'),
    }),
  ]))
  app.mount(host)
  cleanup = () => app.unmount()
  return { open, opener: host.querySelector('button')! }
}

describe('ResponsiveOverlay', () => {
  it.each([false, true])('restores the external opener after Escape (desktop=%s)', async (isDesktop) => {
    // Losing the opener when the portalled input is removed breaks the next keyboard action.
    const { open, opener } = mountOverlay(isDesktop)
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1))
    const input = document.querySelector<HTMLInputElement>('input')!
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.waitFor(() => expect(open.value).toBe(false))
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('keeps one live form and footer while changing modality, then restores focus after save', async () => {
    // CSS-hidden duplicates create two live forms; branch changes must retain the original opener.
    const { open, opener } = mountOverlay(false)
    opener.focus()
    opener.click()
    await vi.waitFor(() => expect(document.querySelector('input')).not.toBeNull())
    document.querySelector<HTMLInputElement>('input')!.focus()
    desktop.value = true
    await nextTick()
    await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1))
    expect(document.querySelectorAll('input[aria-label="Draft"]')).toHaveLength(1)
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save')!
    expect(save).toBeDefined()
    save.click()
    await vi.waitFor(() => expect(open.value).toBe(false))
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
  })
})
