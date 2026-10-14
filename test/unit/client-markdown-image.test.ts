// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConversationAsset } from '@/shared/conversation-assets'

const stored: ConversationAsset[] = []
vi.mock('@/client/lib/api', () => ({
  api: {
    conversationAssets: async () => ({ assets: [...stored] }),
    attachmentUrl: (id: number) => `/api/attachments/${id}`,
  },
}))

const { default: MarkdownImage } = await import('@/client/components/markdown-image.vue')
const { assetsChanged, provideAssetScope } = await import('@/client/lib/asset-refs')

afterEach(() => { document.body.innerHTML = '' })

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

it('shows an image that missed while its reply streamed once the reply is stored', async () => {
  const Scoped = defineComponent({
    setup() {
      provideAssetScope(7)
      return () => h(MarkdownImage, { node: { type: 'image', src: 'asset:aaaaaaaa', alt: 'chart', title: null, raw: '' } })
    },
  })
  const root = document.createElement('div')
  document.body.append(root)
  createApp(Scoped).mount(root)
  await settle()
  expect(document.body.textContent).toContain('找不到图片')

  stored.push({ attachmentId: 5, ref: 'aaaaaaaa', source: 'tool', mime: 'image/png', size: 1, width: 1, height: 1, filename: null, createdAt: 0 })
  assetsChanged(7)
  await settle()
  expect(document.querySelector('img')?.getAttribute('src')).toBe('/api/attachments/5')
})
