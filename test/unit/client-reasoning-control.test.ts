// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import ReasoningControl from '@/client/components/reasoning-control.vue'
import { TooltipProvider } from '@/client/ui/tooltip'
import type { ReasoningChoice } from '@/client/stores/sync'

const desktop = ref(true)
vi.mock('@vueuse/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@vueuse/core')>(),
  useMediaQuery: () => desktop,
}))

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

function mountControl(isDesktop: boolean, noModel = false) {
  desktop.value = isDesktop
  const active = ref<ReasoningChoice>('high')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(TooltipProvider, null, () => h(ReasoningControl, {
    metadata: { reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'high'] }] },
    active: active.value, overridden: true, noModel,
    onUpdate: (choice: ReasoningChoice) => { active.value = choice },
  })) })
  app.mount(host)
  cleanup = () => app.unmount()
  return { host, active }
}

it('keeps one reasoning surface and its active choice through Popover/Drawer transitions', async () => {
  const { host, active } = mountControl(true)
  const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  trigger().focus()
  trigger().click()
  await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull())
  expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull()
  document.querySelector<HTMLButtonElement>('#oc-reasoning-auto')!.click()
  await nextTick()
  expect(active.value).toBe('auto')
  desktop.value = false
  await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-content"]')).toBeNull())
  expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull()
  await vi.waitFor(() => expect(document.activeElement === trigger()).toBe(true))
  trigger().click()
  await vi.waitFor(() => expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull())
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
  expect(active.value).toBe('auto')
  document.querySelector<HTMLButtonElement>('#oc-reasoning-auto')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement === trigger()).toBe(true))
  desktop.value = true
  await nextTick()
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  expect(trigger().textContent).toContain('自动')
})

it.each([false, true])('keeps disabled reasoning explanations focusable without opening (desktop=%s)', async (isDesktop) => {
  const { host } = mountControl(isDesktop, true)
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
  trigger.focus()
  trigger.click()
  await nextTick()
  expect(trigger.disabled).toBe(false)
  expect(trigger.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement === trigger).toBe(true)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
