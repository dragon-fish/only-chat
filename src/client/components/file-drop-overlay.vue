<script setup lang="ts">
import { ImageUpIcon } from '@lucide/vue'

/**
 * The "you can drop this here" affordance for a page-wide drop zone, rendered into `body` so it
 * covers the viewport regardless of where the component that owns the drop zone sits in the layout.
 *
 * `pointer-events-none` is load-bearing, not cosmetic. An overlay that accepts pointer events
 * inserts itself between the cursor and the element whose `dragleave` ends the drag, which strands
 * the highlight on and keeps `drop` from ever reaching its handler.
 */
withDefaults(defineProps<{
  show: boolean
  label?: string
}>(), { label: '松开以添加图片' })
</script>

<template lang="pug">
Teleport(to="body")
  Transition(
    enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0"
    leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0")
    .pointer-events-none.fixed.inset-0.z-50.flex.items-center.justify-center.p-6(
      v-if="show" class="bg-background/70 backdrop-blur-sm")
      .flex.flex-col.items-center.gap-3.rounded-2xl.border-2.border-dashed.px-8.py-6.text-center(
        class="border-primary bg-background/80 shadow-lg")
        ImageUpIcon(class="size-10 text-primary")
        p.text-base.font-medium {{ label }}
</template>
