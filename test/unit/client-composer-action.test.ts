// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it } from 'vitest'
import Composer from '@/client/components/composer.vue'
import { TooltipProvider } from '@/client/ui/tooltip'
import type { Part } from '@/shared/parts'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

interface Fired { send: Part[][], queue: Part[][], interrupt: Part[][], stop: number }

function mount(options: { streaming: boolean, stash?: Part[] }) {
  const host = document.createElement('div')
  document.body.append(host)
  const fired: Fired = { send: [], queue: [], interrupt: [], stop: 0 }
  const app = createApp({
    setup: () => () => h(TooltipProvider, null, { default: () => h(Composer, {
      streaming: options.streaming,
      connected: true,
      canSend: true,
      stash: options.stash ?? [],
      onSend: (parts: Part[]) => fired.send.push(parts),
      onQueue: (parts: Part[]) => fired.queue.push(parts),
      onInterrupt: (parts: Part[]) => fired.interrupt.push(parts),
      onStop: () => { fired.stop += 1 },
    }) }),
  }).use(createPinia()).use(createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  }))
  app.mount(host)
  cleanup = () => app.unmount()
  return { host, fired }
}

/** Type into the box and press Enter, the way the keyboard path is actually used. */
async function typeAndEnter(host: HTMLElement, value: string) {
  const box = host.querySelector('textarea')!
  box.value = value
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await Promise.resolve()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await Promise.resolve()
}

it('sends when nothing is generating', async () => {
  const { host, fired } = mount({ streaming: false })
  await typeAndEnter(host, 'hello')
  expect(fired.send).toHaveLength(1)
  expect(fired.stop).toBe(0)
})

it('queues rather than interrupting while a turn is running', async () => {
  // The position that sends used to become the position that stops, so a reflexive Enter killed
  // the work. Typing while it runs must never abort it.
  const { host, fired } = mount({ streaming: true })
  await typeAndEnter(host, '123')
  expect(fired.queue).toEqual([[{ type: 'text', text: '123' }]])
  expect(fired.stop).toBe(0)
  expect(fired.send).toHaveLength(0)
})

it('stops only when there is nothing to say', async () => {
  const { host, fired } = mount({ streaming: true })
  host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await Promise.resolve()
  expect(fired.stop).toBe(1)
})

it('keeps queueing while there is something in the box, however much is waiting', async () => {
  // The queue has no limit. A control that stopped accepting additions once one message was
  // waiting would refuse the obvious next thing to do.
  const { host, fired } = mount({ streaming: true, stash: [{ type: 'text', text: 'earlier' }] })
  await typeAndEnter(host, 'and this')
  expect(fired.queue).toEqual([[{ type: 'text', text: 'and this' }]])
  expect(fired.interrupt).toHaveLength(0)
})

it('interrupts on an empty box once something is waiting', async () => {
  // Nothing more to add: send it now rather than waiting for a boundary that may never come.
  const { host, fired } = mount({ streaming: true, stash: [{ type: 'text', text: 'earlier' }] })
  host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await Promise.resolve()
  expect(fired.interrupt).toEqual([[]])
  expect(fired.stop).toBe(0)
})
