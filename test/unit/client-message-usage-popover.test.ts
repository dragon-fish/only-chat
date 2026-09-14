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
