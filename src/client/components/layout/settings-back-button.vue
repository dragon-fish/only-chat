<script setup lang="ts">
import { ArrowLeftIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/client/ui/button'

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
