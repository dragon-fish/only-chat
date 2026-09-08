// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/client/ui/message-scroller'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

it('preserves the viewport when an assistant branch replaces another assistant', async () => {
  const rows = ref(Array.from({ length: 8 }, (_, index) => ({
    id: `${index % 2 === 0 ? 'user' : 'assistant'}-${index}`,
    anchor: index % 2 === 0,
  })))
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('aria-label') === 'Messages' ? 200 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const viewport = document.querySelector<HTMLElement>('[aria-label="Messages"]')
    if (this === viewport) return new DOMRect(0, 0, 600, 200)
    if (this.getAttribute('role') === 'log') return new DOMRect(0, -(viewport?.scrollTop ?? 0), 600, 1000)
    if (this.hasAttribute('data-message-id')) {
      const index = [...this.parentElement!.children].indexOf(this)
      const height = index === 7 ? 300 : 100
      return new DOMRect(0, index * 100 - (viewport?.scrollTop ?? 0), 600, height)
    }
    return new DOMRect()
  })

  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(
      MessageScrollerProvider,
      { autoScroll: true, defaultScrollPosition: 'last-anchor' },
      () => h(MessageScroller, null, () => h(
        MessageScrollerViewport,
        null,
        () => h(MessageScrollerContent, null, () => rows.value.map(row => h(
          MessageScrollerItem,
          { key: row.id, messageId: row.id, scrollAnchor: row.anchor },
          () => row.id,
        ))),
      )),
    ),
  })
  app.mount(host)
  cleanup = () => app.unmount()

  const viewport = document.querySelector<HTMLElement>('[aria-label="Messages"]')!
  await vi.waitFor(() => expect(viewport.scrollTop).toBe(536))
  rows.value = rows.value.map((row, index) => index === 7 ? { id: 'assistant-replacement', anchor: false } : row)
  await nextTick()
  await vi.waitFor(() => expect(viewport.textContent).toContain('assistant-replacement'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(viewport.scrollTop).toBe(536)
})
