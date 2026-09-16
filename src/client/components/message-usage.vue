<script setup lang="ts">
import { computed } from 'vue'
import { messageUsageMetrics } from '@/client/lib/ui-models'
import { ChevronDownIcon } from '@lucide/vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/client/ui/hover-card'
import { Separator } from '@/client/ui/separator'
import type { Usage } from '@/shared/models'

const props = defineProps<{ usage: Usage }>()
const metrics = computed(() => messageUsageMetrics(props.usage))
/**
 * Only worth showing when there was more than one: a single round trip's numbers are the turn's,
 * and repeating them under a disclosure would suggest a distinction that is not there.
 */
const steps = computed(() => (props.usage.steps?.length ?? 0) > 1 ? props.usage.steps! : null)
/** What the conversation actually carries: the last round trip, never the sum of all of them. */
const context = computed(() => {
  const last = props.usage.steps?.at(-1)
  if (!last || steps.value === null) return null
  return (last.prompt ?? 0) + (last.completion ?? 0)
})
const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

function count(value: number | undefined) { return value === undefined ? '未报告' : numbers.format(value) }
function tokenCount(value: number | undefined) { return value === undefined ? '未报告' : `${numbers.format(value)} Tokens` }
function percent(value: number) { return `${numbers.format(value)}%` }
function rate(value: number) { return `${numbers.format(value)} toks/s` }
function duration(value: number | undefined) {
  if (value === undefined) return '未报告'
  return value < 1_000 ? `${Math.round(value)} ms` : `${numbers.format(value / 1_000)} s`
}
</script>

<template lang="pug">
HoverCard(:open-delay="150" :close-delay="100" :enable-touch="true")
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
  HoverCardContent(align="start" class="w-[22rem] max-w-[calc(100vw-1rem)] p-3")
    .flex.flex-col.gap-3
      .flex.items-center.justify-between
        h4.text-sm.font-medium 本轮用量
        span.text-xs.text-muted-foreground(v-if="steps") {{ steps.length }} 次往返 · 合计计费
        span.text-xs.text-muted-foreground(v-else) 模型生成统计
      .rounded-lg.border.p-2.text-xs(v-if="context !== null" class="bg-muted/45")
        span.text-muted-foreground 上下文（最后一轮）
        span.ml-2.font-semibold.tabular-nums {{ count(context) }} Tokens
        .mt-1.text-muted-foreground 下面的输入输出是每次往返的合计——工具调用会把整段对话重发一遍，所以它是花费，不是上下文。
      .grid.grid-cols-3.gap-2
        .rounded-lg.border.bg-muted.p-2(class="bg-muted/45")
          .text-xs.text-muted-foreground 输入 (tokens)
          .mt-1.text-base.font-semibold.tabular-nums {{ count(usage.prompt) }}
        .rounded-lg.border.bg-muted.p-2(class="bg-muted/45")
          .text-xs.text-muted-foreground 输出 (tokens)
          .mt-1.text-base.font-semibold.tabular-nums {{ count(usage.completion) }}
        .rounded-lg.border.bg-muted.p-2(class="bg-muted/45")
          .text-xs.text-muted-foreground 生成 (TPS)
          .mt-1.text-base.font-semibold.tabular-nums {{ metrics.tokensPerSecond === null ? '未报告' : count(metrics.tokensPerSecond) }}
      Separator
      dl.grid.grid-cols-2.gap-x-6.gap-y-3.text-xs
        div
          dt.text-muted-foreground 思考 Token
          dd.mt-1.tabular-nums {{ tokenCount(usage.reasoning) }}
        div
          dt.text-muted-foreground 缓存读取
          dd.mt-1.tabular-nums {{ tokenCount(usage.cached) }}
        div
          dt.text-muted-foreground 缓存占比
          dd.mt-1.tabular-nums {{ metrics.cachedPercent === null ? '未报告' : percent(metrics.cachedPercent) }}
        div
          dt.text-muted-foreground 首 Token 延迟
          dd.mt-1.tabular-nums {{ duration(usage.time_to_first_token_ms) }}
        div
          dt.text-muted-foreground 模型生成耗时
          dd.mt-1.tabular-nums {{ duration(usage.generation_duration_ms) }}
        div
          dt.text-muted-foreground 本轮总耗时
          dd.mt-1.tabular-nums {{ duration(usage.total_duration_ms) }}
      template(v-if="steps")
        Separator
        Collapsible
          CollapsibleTrigger.flex.w-full.items-center.justify-between.rounded.px-1.py-1.text-xs.transition-colors(
            class="hover:bg-muted [&[data-state=open]>svg]:rotate-180")
            span 查看每轮往返（{{ steps.length }}）
            ChevronDownIcon(class="size-3.5 shrink-0 text-muted-foreground transition-transform")
          CollapsibleContent
            ul.mt-1.flex.flex-col.gap-1.text-xs.tabular-nums
              li.flex.items-center.gap-2.px-1(v-for="(step, index) in steps" :key="index")
                span.w-6.shrink-0.text-muted-foreground {{ index + 1 }}
                span {{ count(step.prompt) }} ↑
                span.text-muted-foreground ·
                span {{ count(step.completion) }} ↓
                span.ml-auto.text-muted-foreground(v-if="step.cached !== undefined && step.prompt") {{ percent(step.cached / step.prompt * 100) }} cached
</template>
