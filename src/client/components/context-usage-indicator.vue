<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { compactTokenCount as compact, messageContextUsage } from '@/client/lib/ui-models'
import { Button } from '@/client/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/client/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import type { Usage } from '@/shared/models'

/** `'pending'`: compacted, and nothing has measured the new context yet. */
const props = defineProps<{ usage: Usage | 'pending', limit: number }>()
const isDesktop = useMediaQuery('(min-width: 768px)')
const open = ref(false)
const pending = computed(() => props.usage === 'pending')
const context = computed(() => props.usage === 'pending' ? null : messageContextUsage(props.usage, props.limit))
const circumference = 2 * Math.PI * 8
const dashOffset = computed(() => circumference * (1 - Math.min(context.value?.percent ?? 0, 100) / 100))
const tone = computed(() => {
  const percent = context.value?.percent ?? 0
  if (percent >= 85) return 'text-destructive'
  if (percent >= 60) return 'text-warning'
  return 'text-success'
})
const percentages = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
</script>

<template>
  <component :is="isDesktop ? HoverCard : Popover" v-if="context || pending" v-model:open="open">
    <component :is="isDesktop ? HoverCardTrigger : PopoverTrigger" as-child>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        class="size-10 md:size-6"
        :aria-label="pending ? '上下文用量待测量' : '查看上下文用量'"
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
            :stroke-dasharray="pending ? '2 3' : circumference"
            :stroke-dashoffset="pending ? 0 : dashOffset"
            :class="pending ? 'text-muted-foreground' : tone"
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
      <p v-if="pending" class="text-xs">
        上下文用量待测量 · 已压缩，下一次回复后更新
      </p>
      <p v-else-if="context" class="whitespace-nowrap text-xs tabular-nums">
        上下文用量 {{ compact(context.used) }} / {{ compact(context.limit) }} ({{ percentages.format(context.percent) }}%)
      </p>
    </component>
  </component>
</template>
