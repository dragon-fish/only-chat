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

interface Fired { send: Part[][], queue: Part[][], interrupt: Part[][], stop: number, withdraw: number }

function mount(options: { streaming: boolean, stash?: Part[] }) {
  const host = document.createElement('div')
  document.body.append(host)
  const fired: Fired = { send: [], queue: [], interrupt: [], stop: 0, withdraw: 0 }
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
      onWithdraw: () => { fired.withdraw += 1 },
    }) }),
  }).use(createPinia()).use(createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  }))
  app.mount(host)
  cleanup = () => app.unmount()
  return { host, fired }
}

function press(host: HTMLElement, key: string) {
  host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  return Promise.resolve()
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

it('does nothing at all when Enter is pressed on an empty box', async () => {
  // Enter is the gesture for sending. Stopping is not something to hand a stray keypress.
  const { host, fired } = mount({ streaming: true })
  host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await Promise.resolve()
  expect(fired).toMatchObject({ send: [], queue: [], interrupt: [], stop: 0 })
})

it('stops when the button is pressed, which is what the button is for', async () => {
  const { host, fired } = mount({ streaming: true })
  host.querySelector<HTMLElement>('[aria-label="停止生成"]')!.click()
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

it('interrupts from the button once something is waiting', async () => {
  // Nothing more to add: send it now rather than waiting for a boundary that may never come.
  const { host, fired } = mount({ streaming: true, stash: [{ type: 'text', text: 'earlier' }] })
  host.querySelector<HTMLElement>('[aria-label="打断并立即送出已排队的消息"]')!.click()
  await Promise.resolve()
  expect(fired.interrupt).toEqual([[]])
  expect(fired.stop).toBe(0)
})

it('stops on Escape when nothing is waiting to be said', async () => {
  const { host, fired } = mount({ streaming: true })
  await press(host, 'Escape')
  expect(fired.stop).toBe(1)
  expect(fired.withdraw).toBe(0)
})

it('stops on Escape even with something typed, as long as nothing is waiting', async () => {
  // Escape reads the stash, never the box. What is typed decides between sending and queueing.
  const { host, fired } = mount({ streaming: true })
  const box = host.querySelector('textarea')!
  box.value = 'half a thought'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await Promise.resolve()
  await press(host, 'Escape')
  expect(fired.stop).toBe(1)
  expect(fired.withdraw).toBe(0)
})

it('takes the stash back on Escape rather than stopping', async () => {
  // Innermost first: what is waiting is nearer than the turn, and undoing it should not also end
  // the work. Sending it now is the orange button's job, not something to reach with Escape.
  const { host, fired } = mount({ streaming: true, stash: [{ type: 'text', text: 'earlier' }] })
  await press(host, 'Escape')
  expect(fired.withdraw).toBe(1)
  expect(fired.stop).toBe(0)
  expect(fired.interrupt).toHaveLength(0)
})

it('ignores Escape when nothing is generating', async () => {
  const { host, fired } = mount({ streaming: false })
  await press(host, 'Escape')
  expect(fired).toMatchObject({ stop: 0, interrupt: [], withdraw: 0 })
})
