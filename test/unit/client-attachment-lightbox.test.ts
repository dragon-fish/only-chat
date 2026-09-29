// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, expect, it } from 'vitest'
import AttachmentLightbox from '@/client/components/attachment-lightbox.vue'

afterEach(() => { document.body.innerHTML = '' })

it('shows the chosen image, steps within the set and closes back to nothing', async () => {
  const index = ref<number | null>(0)
  const images = [{ url: '/api/attachments/1', name: 'cat.png' }, { url: '/api/attachments/2', name: 'dog.png' }]
  const root = document.createElement('div')
  document.body.append(root)
  createApp({ render: () => h(AttachmentLightbox, { images, index: index.value, 'onUpdate:index': (value: number | null) => { index.value = value } }) }).mount(root)
  await nextTick()
  const shown = () => document.querySelector('img')?.getAttribute('src')
  expect(shown()).toBe('/api/attachments/1')

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
  await nextTick()
  expect(shown()).toBe('/api/attachments/2')
  // The last image has nowhere further to go.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
  await nextTick()
  expect(index.value).toBe(1)

  document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()
  await nextTick()
  expect(index.value).toBeNull()
})
