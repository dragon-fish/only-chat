<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/client/ui/button'

const props = withDefaults(defineProps<{
  to?: string
  label?: string
  /**
   * Settings pages normally hide this on desktop, where the sidebar is the way back. A page whose
   * parent is not a sidebar entry — a plugin's own configuration, say — has no such affordance and
   * asks for the arrow at every width.
   */
  alwaysVisible?: boolean
}>(), {
  to: '/settings',
  label: '返回设置',
  alwaysVisible: false,
})

// Built here rather than in the template: `md:hidden` carries a colon, which Pug's class shorthand
// cannot express, and a ternary inside a bound class is harder to read than a name.
const sizing = computed(() => (props.alwaysVisible ? 'size-10' : 'size-10 md:hidden'))
</script>

<template lang="pug">
Button(as-child variant="ghost" size="icon" :class="sizing")
  RouterLink(:to="to" :aria-label="label")
    ArrowLeftIcon(data-icon="inline-start")
</template>
