<script setup lang="ts">
import { computed } from 'vue'
import { messageUsageMetrics } from '@/client/lib/ui-models'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/client/ui/hover-card'
import { Separator } from '@/client/ui/separator'
import type { Usage } from '@/shared/models'

const props = defineProps<{ usage: Usage }>()
const metrics = computed(() => messageUsageMetrics(props.usage))
const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function count(value: number | undefined) { return value === undefined ? '未报告' : numbers.format(value) }
function percent(value: number) { return `${numbers.format(value)}%` }
function rate(value: number) { return `${numbers.format(value)} toks/s` }
function duration(value: number | undefined) {
  if (value === undefined) return '未报告'
  return value < 1_000 ? `${Math.round(value)} ms` : `${numbers.format(value / 1_000)} s`
}
</script>

<template lang="pug">
HoverCard(:open-delay="150" :close-delay="100")
  HoverCardTrigger(as-child)
    button.flex.min-h-6.items-center.gap-1.rounded.px-1.tabular-nums.transition-colors(
      type="button" class="hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="查看本轮用量详情")
      span {{ count(usage.prompt) }} ↑
      span ·
      span {{ count(usage.completion) }} ↓
      template(v-if="metrics.cachedPercent !== null")
        span.hidden(class="md:inline") ({{ percent(metrics.cachedPercent) }} cached)
      template(v-if="metrics.tokensPerSecond !== null")
        span.hidden(class="md:inline") · {{ rate(metrics.tokensPerSecond) }}
  HoverCardContent(align="start" class="w-72")
    .flex.flex-col.gap-3
      h4.text-sm.font-medium 本轮用量
      dl.grid.grid-cols-2.gap-x-4.gap-y-1.text-xs
        dt.text-muted-foreground 输入 Token
        dd.text-right.tabular-nums {{ count(usage.prompt) }}
        dt.text-muted-foreground 输出 Token
        dd.text-right.tabular-nums {{ count(usage.completion) }}
        dt.text-muted-foreground 思考 Token
        dd.text-right.tabular-nums {{ count(usage.reasoning) }}
        dt.text-muted-foreground 缓存读取
        dd.text-right.tabular-nums {{ count(usage.cached) }}
        dt.text-muted-foreground 缓存占比
        dd.text-right.tabular-nums {{ metrics.cachedPercent === null ? '未报告' : percent(metrics.cachedPercent) }}
      Separator
      dl.grid.grid-cols-2.gap-x-4.gap-y-1.text-xs
        dt.text-muted-foreground 首 Token 延迟
        dd.text-right.tabular-nums {{ duration(usage.time_to_first_token_ms) }}
        dt.text-muted-foreground 生成耗时
        dd.text-right.tabular-nums {{ duration(usage.generation_duration_ms) }}
        dt.text-muted-foreground 总耗时
        dd.text-right.tabular-nums {{ duration(usage.total_duration_ms) }}
        dt.text-muted-foreground 生成速度
        dd.text-right.tabular-nums {{ metrics.tokensPerSecond === null ? '未报告' : rate(metrics.tokensPerSecond) }}
</template>
