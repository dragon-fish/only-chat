<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import {
  Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle,
} from '@/client/ui/drawer'
import {
  Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle,
} from '@/client/ui/sheet'

defineProps<{
  open: boolean
  title: string
}>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const isDesktop = useMediaQuery('(min-width: 768px)')
</script>

<template lang="pug">
Sheet(v-if="isDesktop" :open="open" @update:open="emit('update:open', $event)")
  SheetContent(side="right")
    SheetHeader
      SheetTitle {{ title }}
    .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-4.pb-4
      slot
    SheetFooter(v-if="$slots.footer")
      slot(name="footer")
Drawer(v-else :open="open" @update:open="emit('update:open', $event)")
  DrawerContent(class="overflow-hidden")
    DrawerHeader
      DrawerTitle {{ title }}
    .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-4.pb-4
      slot
    DrawerFooter(v-if="$slots.footer")
      slot(name="footer")
</template>
