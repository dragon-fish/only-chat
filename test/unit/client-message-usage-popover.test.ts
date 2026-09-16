// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { afterEach, expect, it } from 'vitest'
import MessageUsage from '@/client/components/message-usage.vue'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

it('opens the usage details when a touch pointer taps the trigger', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(MessageUsage, {
    usage: { prompt: 200, completion: 100, cached: 50, reasoning: 25, time_to_first_token_ms: 400, generation_duration_ms: 2_000, total_duration_ms: 8_000 },
  })
  app.mount(host)
  cleanup = () => app.unmount()

  host.querySelector<HTMLButtonElement>('[aria-label="查看本轮用量详情"]')!
    .dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
  await nextTick()

  expect(document.body.querySelector('[data-slot="hover-card-content"]')).not.toBeNull()
})

it('shows the context as the last round trip, with the round trips behind a disclosure', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(MessageUsage, {
    usage: {
      prompt: 300, completion: 34, cached: 280,
      steps: [
        { prompt: 100, completion: 20, cached: 90 },
        { prompt: 100, completion: 10, cached: 95 },
        { prompt: 100, completion: 4, cached: 95 },
      ],
    },
  })
  app.mount(host)
  cleanup = () => app.unmount()

  host.querySelector<HTMLButtonElement>('[aria-label="查看本轮用量详情"]')!
    .dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
  await nextTick()
  const card = document.body.querySelector('[data-slot="hover-card-content"]')!

  // 104, not 334: the totals are three round trips added up, and reading them as a context size is
  // what pins the gauge past its limit on a conversation with room to spare.
  expect(card.textContent).toContain('104')
  expect(card.textContent).toContain('3 次往返')
  expect(card.textContent).toContain('查看每轮往返（3）')
})
