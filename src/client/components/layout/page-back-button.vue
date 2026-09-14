<script setup lang="ts">
import { ArrowLeftIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/client/ui/button'

/**
 * The way back on a phone, where there is no sidebar to return through.
 *
 * Defaults to settings because that is where it started and most of its callers still live there.
 * It was named for them too, which is why a screen that needed exactly this — the image studio —
 * went without one: the name said it did not apply.
 */
withDefaults(defineProps<{ to?: string; label?: string }>(), {
  to: '/settings',
  label: '返回设置',
})
</script>

<template lang="pug">
Button(as-child variant="ghost" size="icon" class="size-10 md:hidden")
  RouterLink(:to="to" :aria-label="label")
    ArrowLeftIcon(data-icon="inline-start")
</template>
