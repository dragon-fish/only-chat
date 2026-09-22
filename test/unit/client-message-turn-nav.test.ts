// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type Component } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MessageTurn } from '@/client/lib/message-turns'

const scrollToMessage = vi.fn()
const visibility = ref({ currentAnchorId: null as string | null, visibleMessageIds: [] as string[] })
const scrollable = ref({ start: false, end: true })
vi.mock('@/client/ui/message-scroller', () => ({
  useMessageScroller: () => ({ scrollToMessage, scrollToEnd: vi.fn(), scrollToStart: vi.fn() }),
  useMessageScrollerVisibility: () => visibility,
  useMessageScrollerScrollable: () => scrollable,
}))

const turns: MessageTurn[] = [{ id: 1, prompt: 'first', reply: 'a' }, { id: 5, prompt: 'second', reply: 'b' }]
let cleanup = () => {}
beforeEach(() => {
  visibility.value = { currentAnchorId: null, visibleMessageIds: [] }
  scrollable.value = { start: false, end: true }
  scrollToMessage.mockClear()
})
afterEach(() => { cleanup(); document.body.innerHTML = '' })

async function mount(path: string, entries = turns) {
  const component = (await import(path)).default as Component
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(component, { turns: entries }) })
  app.mount(host)
  cleanup = () => app.unmount()
  return host
}

it('marks the turn being read, the first one above every anchor, and jumps to a turn', async () => {
  const host = await mount('@/client/components/message-rail.vue')
  const active = () => host.querySelector('[aria-current="location"]')?.getAttribute('data-turn')
  expect(active()).toBe('1')
  visibility.value = { currentAnchorId: '5', visibleMessageIds: ['5'] }
  await Promise.resolve()
  expect(active()).toBe('5')
  host.querySelector<HTMLButtonElement>('[data-turn="1"]')!.click()
  expect(scrollToMessage).toHaveBeenCalledWith('1', { behavior: 'smooth' })
})

it('reuses the preview when keyboard focus moves and dismisses it with Escape', async () => {
  const host = await mount('@/client/components/message-rail.vue')
  host.querySelector<HTMLButtonElement>('[data-turn="1"]')!.focus()
  await nextTick()
  const preview = document.querySelector<HTMLElement>('[data-message-rail-preview]')!
  expect(preview).not.toBeNull()
  expect(preview.textContent).toContain('first')
  host.querySelector<HTMLButtonElement>('[data-turn="5"]')!.focus()
  await nextTick()
  expect(document.querySelector('[data-message-rail-preview]')).toBe(preview)
  expect(preview.textContent).toContain('second')
  expect(preview.textContent).not.toContain('first')
  host.querySelector('[data-turn="5"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(preview.dataset.open).toBeUndefined()
})

it('marks the final turn at the bottom even when its anchor cannot reach the top', async () => {
  const host = await mount('@/client/components/message-rail.vue')
  const active = () => host.querySelector('[aria-current="location"]')?.getAttribute('data-turn')
  visibility.value = { currentAnchorId: '1', visibleMessageIds: ['1', '5'] }
  scrollable.value = { start: true, end: false }
  await nextTick()
  expect(active()).toBe('5')
  scrollable.value = { start: true, end: true }
  await nextTick()
  expect(active()).toBe('1')
  scrollable.value = { start: false, end: false }
  await nextTick()
  expect(active()).toBe('5')
})

it('keeps visible active ticks stationary and reveals only offscreen ticks', async () => {
  const entries = Array.from({ length: 120 }, (_, id) => ({ id, prompt: `turn ${id}`, reply: '' }))
  const host = await mount('@/client/components/message-rail.vue', entries)
  const rail = host.querySelector<HTMLElement>('[data-message-rail]')!
  Object.defineProperty(rail, 'clientHeight', { value: 200 })
  visibility.value = { currentAnchorId: '5', visibleMessageIds: ['5'] }
  await nextTick()
  expect(rail.scrollTop).toBe(0)
  visibility.value = { currentAnchorId: '119', visibleMessageIds: ['119'] }
  await nextTick()
  expect(rail.scrollTop).toBeGreaterThan(0)
})

it('updates only nearby ticks and keeps the rail stable while browsing previews', async () => {
  const entries = Array.from({ length: 120 }, (_, id) => ({ id, prompt: `prompt-${id}`, reply: `reply-${id}` }))
  const host = await mount('@/client/components/message-rail.vue', entries)
  const rail = host.querySelector<HTMLElement>('[data-message-rail]')!
  Object.defineProperty(rail, 'clientHeight', { value: 200 })
  rail.dispatchEvent(new PointerEvent('pointerenter', { clientY: 63 }))
  await vi.waitFor(() => expect(document.querySelector('[data-message-rail-preview]')?.textContent).toContain('prompt-5'))
  expect(rail.querySelectorAll('[data-hovered]')).toHaveLength(1)
  expect(rail.querySelector('[data-hovered]')?.parentElement?.getAttribute('data-turn')).toBe('5')
  const modified = [...rail.querySelectorAll('span')].filter(span => span.style.getPropertyValue('--swell'))
  expect(modified.length).toBeGreaterThan(1)
  expect(modified.length).toBeLessThan(20)
  visibility.value = { currentAnchorId: '119', visibleMessageIds: ['119'] }
  await nextTick()
  expect(rail.scrollTop).toBe(0)
  rail.scrollTop = 300
  rail.dispatchEvent(new Event('scroll'))
  await vi.waitFor(() => expect(document.querySelector('[data-message-rail-preview]')?.textContent).toContain('prompt-35'))
  expect(rail.querySelectorAll('[data-hovered]')).toHaveLength(1)
  expect(rail.querySelector('[data-hovered]')?.parentElement?.getAttribute('data-turn')).toBe('35')
  rail.dispatchEvent(new PointerEvent('pointerleave'))
  expect(rail.querySelector('[data-hovered]')).toBeNull()
  expect([...rail.querySelectorAll('span')].some(span => span.style.getPropertyValue('--swell'))).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(document.querySelector<HTMLElement>('[data-message-rail-preview]')!.dataset.open).toBeUndefined()
})

it('closes the mobile outline and jumps to the picked turn', async () => {
  const host = await mount('@/client/components/message-outline.vue')
  host.querySelector<HTMLButtonElement>('[data-message-outline]')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [data-turn="5"]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('[role="dialog"] [data-turn="5"]')!.click()
  expect(scrollToMessage).toHaveBeenCalledWith('5', { behavior: 'smooth' })
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
})
