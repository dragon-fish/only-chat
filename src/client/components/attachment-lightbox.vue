<script setup lang="ts">
import { computed } from 'vue'
import { useEventListener } from '@vueuse/core'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, XIcon } from '@lucide/vue'
import { withDownloadName } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/client/ui/dialog'
import { Separator } from '@/client/ui/separator'

/**
 * A plain image viewer for attachments: an uploaded image, or one the chat model drew. Images from
 * an image run open `ImageArtifactDetail` instead, which knows their prompt and model. Looks and
 * steps like that viewer, so the two read as one.
 */
export interface LightboxImage {
  url: string
  name?: string
}

const props = defineProps<{ images: readonly LightboxImage[], index: number | null }>()
const emit = defineEmits<{ 'update:index': [value: number | null] }>()

const current = computed(() => (props.index === null ? null : props.images[props.index] ?? null))
const hasPrevious = computed(() => props.index !== null && props.index > 0)
const hasNext = computed(() => props.index !== null && props.index < props.images.length - 1)

function close() { emit('update:index', null) }
function step(delta: number) {
  if (props.index === null) return
  const target = props.index + delta
  if (target >= 0 && target < props.images.length) emit('update:index', target)
}
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (props.index === null || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  if (event.key === 'ArrowLeft') step(-1)
  else if (event.key === 'ArrowRight') step(1)
})

/** The viewer is dark in both themes, so its controls cannot use the theme's ghost colours. */
const toolClass = 'rounded-full text-white/85 hover:bg-white/15 hover:text-white disabled:text-white/30'
</script>

<template lang="pug">
Dialog(:open="current !== null" @update:open="!$event && close()")
  DialogContent(
    :show-close-button="false" :aria-describedby="undefined"
    class="left-0 top-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-black/95 p-0 text-white ring-0 sm:max-w-none")
    DialogTitle.sr-only {{ current?.name ?? '图片' }}
    Button(
      size="icon" variant="ghost" aria-label="关闭" @click="close"
      :class="[toolClass, 'absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10']")
      XIcon
    //- A click on the empty stage around the image closes, like any lightbox.
    .flex.min-h-0.flex-1.items-center.justify-center.px-4.pb-24.pt-16(class="md:px-16" @click.self="close")
      img.max-h-full.max-w-full.rounded-md.object-contain(v-if="current" :src="current.url" :alt="current.name ?? ''")
    .pointer-events-none.absolute.inset-x-0.bottom-0.flex.justify-center.p-4(class="pb-[max(1rem,env(safe-area-inset-bottom))]")
      .pointer-events-auto.flex.items-center.gap-1.rounded-full.p-1.shadow-lg.ring-1.backdrop-blur(
        v-if="current" class="bg-neutral-900/85 p-1.5 ring-white/10")
        template(v-if="images.length > 1")
          Button(size="icon" variant="ghost" :class="toolClass" aria-label="上一张" :disabled="!hasPrevious" @click="step(-1)")
            ChevronLeftIcon
          span.min-w-12.text-center.text-xs.tabular-nums(class="text-white/70") {{ (index ?? 0) + 1 }} / {{ images.length }}
          Button(size="icon" variant="ghost" :class="toolClass" aria-label="下一张" :disabled="!hasNext" @click="step(1)")
            ChevronRightIcon
          Separator.mx-1.h-5(orientation="vertical" class="bg-white/15")
        Button(size="icon" variant="ghost" :class="toolClass" as-child)
          a(:href="withDownloadName(current.url, current.name ?? 'image')" :download="current.name ?? 'image'" aria-label="下载原图")
            DownloadIcon
</template>
