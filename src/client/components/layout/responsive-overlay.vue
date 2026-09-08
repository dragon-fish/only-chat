<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { nextTick, onBeforeUnmount, watch } from 'vue'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/client/ui/dialog'
import {
  Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle,
} from '@/client/ui/drawer'
import {
  Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle,
} from '@/client/ui/sheet'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  mode?: 'side' | 'dialog'
}>(), { mode: 'side' })

const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const isDesktop = useMediaQuery('(min-width: 768px)')
let opener: HTMLElement | null = null
let unmounting = false
onBeforeUnmount(() => { unmounting = true })

watch(() => props.open, (open) => {
  if (open && typeof document !== 'undefined') {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
}, { flush: 'sync', immediate: true })

function restoreFocus(event: Event) {
  // A breakpoint change unmounts one focus scope while the next one is opening.
  event.preventDefault()
  if (!props.open || unmounting) {
    const target = opener
    // Nested confirmations must finish releasing their focus traps before restoring the opener.
    void nextTick(() => { if (target?.isConnected) target.focus({ preventScroll: true }) })
  }
}
</script>

<template lang="pug">
Dialog(v-if="mode === 'dialog'" :open="open" @update:open="emit('update:open', $event)")
  DialogContent(
    :aria-describedby="undefined" @close-auto-focus="restoreFocus"
    class="left-0 top-0 flex h-dvh max-h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-none md:left-1/2 md:top-1/2 md:h-auto md:max-h-[calc(100dvh-4rem)] md:max-w-3xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl [&>[data-slot=dialog-close]]:size-10")
    DialogHeader(class="shrink-0 px-4 pr-14 pt-[max(1rem,env(safe-area-inset-top))] pb-4")
      .flex.min-h-5.items-center.gap-2
        DialogTitle(class="min-w-0 flex-1") {{ title }}
        slot(name="status")
    .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-4.pb-4
      slot
    DialogFooter(v-if="$slots.footer" class="mx-0 mb-0 shrink-0 flex-col gap-3 rounded-none p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-col md:rounded-b-xl")
      slot(name="footer")
Sheet(v-else-if="isDesktop" :open="open" @update:open="emit('update:open', $event)")
  SheetContent(side="right" :aria-describedby="undefined" @close-auto-focus="restoreFocus")
    SheetHeader(class="min-h-13 flex-row items-center gap-2 pr-14")
      SheetTitle(class="min-w-0 flex-1") {{ title }}
      slot(name="status")
    .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-4.pb-4
      slot
    SheetFooter(v-if="$slots.footer")
      slot(name="footer")
Drawer(v-else :open="open" @update:open="emit('update:open', $event)")
  DrawerContent(class="overflow-hidden pb-[max(1rem,env(safe-area-inset-bottom))]" :aria-describedby="undefined" @close-auto-focus="restoreFocus")
    DrawerHeader(class="min-h-13 flex-row items-center gap-2")
      DrawerTitle(class="min-w-0 flex-1") {{ title }}
      slot(name="status")
    .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-4.pb-4
      slot
    DrawerFooter(v-if="$slots.footer")
      slot(name="footer")
</template>
