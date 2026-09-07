// @ts-ignore Vitest runs this file in Node, while tsconfig.app intentionally excludes Node globals.
import { createRequire } from 'node:module'
import { createSSRApp } from 'vue'
import { describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => ({ __v_isRef: true, value: false }))

vi.mock('@vueuse/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vueuse/core')>()
  return { ...actual, useMediaQuery: () => media }
})

async function overlayStubs(rootName: string, prefix: string) {
  const { defineComponent, h } = await import('vue')
  const Root = defineComponent({
    props: { open: Boolean },
    emits: ['update:open'],
    setup(props, { emit, slots }) {
      if (props.open) emit('update:open', false)
      return () => h(rootName, null, slots.default?.())
    },
  })
  return {
    Root,
    Content: `${prefix}-content`,
    Footer: `${prefix}-footer`,
    Header: `${prefix}-header`,
    Title: `${prefix}-title`,
  }
}

vi.mock('@/client/ui/sheet', async () => {
  const stubs = await overlayStubs('sheet-root', 'sheet')
  return {
    Sheet: stubs.Root,
    SheetContent: stubs.Content,
    SheetFooter: stubs.Footer,
    SheetHeader: stubs.Header,
    SheetTitle: stubs.Title,
  }
})

vi.mock('@/client/ui/drawer', async () => {
  const stubs = await overlayStubs('drawer-root', 'drawer')
  return {
    Drawer: stubs.Root,
    DrawerContent: stubs.Content,
    DrawerFooter: stubs.Footer,
    DrawerHeader: stubs.Header,
    DrawerTitle: stubs.Title,
  }
})

import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'

const requireFromVue = createRequire(import.meta.resolve('vue'))
const { renderToString } = requireFromVue('@vue/server-renderer') as {
  renderToString: (app: ReturnType<typeof createSSRApp>) => Promise<string>
}

describe('ResponsiveOverlay', () => {
  it('mounts only the current overlay branch and preserves the controlled open contract', async () => {
    // Rendering both branches with CSS hiding would duplicate the live form and focus trap; dropping
    // the update handler would make the close affordance ineffective.
    const onOpen = vi.fn()

    media.value = false
    const mobile = await renderToString(createSSRApp(ResponsiveOverlay, {
      open: true,
      title: '会话设置',
      'onUpdate:open': onOpen,
    }))
    expect(mobile).toContain('<drawer-root')
    expect(mobile).not.toContain('<sheet-root')

    media.value = true
    const desktop = await renderToString(createSSRApp(ResponsiveOverlay, {
      open: true,
      title: '会话设置',
      'onUpdate:open': onOpen,
    }))
    expect(desktop).toContain('<sheet-root')
    expect(desktop).not.toContain('<drawer-root')
    expect(desktop.match(/<(?:sheet|drawer)-content/g)).toHaveLength(1)
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenNthCalledWith(1, false)
    expect(onOpen).toHaveBeenNthCalledWith(2, false)
  })
})
