// @vitest-environment happy-dom
import { createApp, h, ref, type Component } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MessageTurn } from '@/client/lib/message-turns'

const scrollToMessage = vi.fn()
const visibility = ref({ currentAnchorId: null as string | null, visibleMessageIds: [] as string[] })
vi.mock('@/client/ui/message-scroller', () => ({
  useMessageScroller: () => ({ scrollToMessage, scrollToEnd: vi.fn(), scrollToStart: vi.fn() }),
  useMessageScrollerVisibility: () => visibility,
}))

const turns: MessageTurn[] = [{ id: 1, prompt: 'first', reply: 'a' }, { id: 5, prompt: 'second', reply: 'b' }]
let cleanup = () => {}
beforeEach(() => { visibility.value = { currentAnchorId: null, visibleMessageIds: [] }; scrollToMessage.mockClear() })
afterEach(() => { cleanup(); document.body.innerHTML = '' })

async function mount(path: string) {
  const component = (await import(path)).default as Component
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(component, { turns }) })
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

it('closes the mobile outline and jumps to the picked turn', async () => {
  const host = await mount('@/client/components/message-outline.vue')
  host.querySelector<HTMLButtonElement>('[data-message-outline]')!.click()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [data-turn="5"]')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('[role="dialog"] [data-turn="5"]')!.click()
  expect(scrollToMessage).toHaveBeenCalledWith('5', { behavior: 'smooth' })
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
})
