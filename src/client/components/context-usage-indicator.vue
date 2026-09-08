<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { messageContextUsage } from '@/client/lib/ui-models'
import { Button } from '@/client/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/client/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import type { Usage } from '@/shared/models'

const props = defineProps<{ usage: Usage, limit: number }>()
const isDesktop = useMediaQuery('(min-width: 768px)')
const open = ref(false)
const context = computed(() => messageContextUsage(props.usage, props.limit))
const circumference = 2 * Math.PI * 8
const dashOffset = computed(() => circumference * (1 - Math.min(context.value?.percent ?? 0, 100) / 100))
const tone = computed(() => {
  const percent = context.value?.percent ?? 0
  if (percent >= 85) return 'text-destructive'
  if (percent >= 60) return 'text-warning'
  return 'text-success'
})
const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const percentages = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function compact(value: number) {
  if (value >= 1_000_000) return `${numbers.format(value / 1_000_000)}M`
  if (value >= 1_000) return `${numbers.format(value / 1_000)}k`
  return numbers.format(value)
}
</script>

<template>
  <component :is="isDesktop ? HoverCard : Popover" v-if="context" v-model:open="open">
    <component :is="isDesktop ? HoverCardTrigger : PopoverTrigger" as-child>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        class="size-10 md:size-6"
        aria-label="查看上下文用量"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 -rotate-90">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2" class="text-muted-foreground/20" />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            :stroke-dasharray="circumference"
            :stroke-dashoffset="dashOffset"
            :class="tone"
          />
        </svg>
      </Button>
    </component>
    <component
      :is="isDesktop ? HoverCardContent : PopoverContent"
      side="top"
      align="end"
      :side-offset="8"
      class="w-auto"
    >
      <p class="whitespace-nowrap text-xs tabular-nums">
        上下文用量 {{ compact(context.used) }} / {{ compact(context.limit) }} ({{ percentages.format(context.percent) }}%)
      </p>
    </component>
  </component>
</template>
