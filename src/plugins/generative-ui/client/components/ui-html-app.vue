<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import { AppWindowIcon } from '@lucide/vue'
import type { NodeProps } from '../runtime'

const { props } = defineProps<NodeProps<{ title?: string, html?: string }>>()
const frame = useTemplateRef<HTMLIFrameElement>('frame')
const MIN_HEIGHT = 120
const MAX_HEIGHT = 640
const height = ref(360)

/**
 * Reports the body's own height, not the document's: `documentElement.scrollHeight` never drops
 * below the frame, so a page could grow the frame but never shrink it. A page sized to 100vh
 * reports the current height back and the frame simply stays put.
 */
const HEIGHT_REPORTER = `<script>(() => {
  const report = () => {
    const body = document.body
    if (!body) return
    const style = getComputedStyle(body)
    const height = body.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
    // +2: a sub-pixel shortfall is enough to bring up a classic scrollbar on desktop.
    parent.postMessage({ ocHtmlAppHeight: Math.ceil(height) + 2 }, '*')
  }
  addEventListener('load', report)
  new ResizeObserver(report).observe(document.body)
  report()
})()<\/script>`

/** Appended at the end of the body: put before the doctype it would drop the page into quirks mode. */
const srcdoc = computed(() => {
  const html = String(props.html ?? '')
  const close = html.search(/<\/body>/i)
  return close >= 0 ? `${html.slice(0, close)}${HEIGHT_REPORTER}${html.slice(close)}` : `${html}${HEIGHT_REPORTER}`
})

function onMessage(event: MessageEvent) {
  if (!frame.value || event.source !== frame.value.contentWindow) return
  const reported = (event.data as { ocHtmlAppHeight?: unknown } | null)?.ocHtmlAppHeight
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    height.value = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, reported))
  }
}
onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<template lang="pug">
.flex.min-w-0.flex-col.overflow-hidden.rounded-xl(class="ring-1 ring-foreground/10")
  .bg-muted.flex.items-center.gap-2.px-3.py-2.text-xs.font-medium
    AppWindowIcon.text-muted-foreground(class="size-3.5")
    span.truncate {{ props.title }}
  //- Sandboxed without allow-same-origin: an opaque origin, so the page cannot read this app's
  //- cookies or reach into the parent; postMessage is its only way out, and only height is heard.
  //- Light on purpose: model-written pages assume a white canvas.
  iframe.block.w-full.bg-white(
    ref="frame" :srcdoc="srcdoc" sandbox="allow-scripts" referrerpolicy="no-referrer"
    :title="props.title" :style="{ height: `${height}px`, colorScheme: 'light' }")
</template>
