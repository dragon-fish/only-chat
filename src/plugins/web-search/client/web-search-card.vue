<script setup lang="ts">
import { computed } from 'vue'
import { GlobeIcon, SearchIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { ToolErrorSchema, ToolRefusalSchema, WebSearchOutputSchema, WebSearchQuerySchema } from '../shared'
import { dateOf, hostOf } from './format'

const props = defineProps<{ call: ToolCallPart; result: ToolResultPart | null }>()

const query = computed(() => WebSearchQuerySchema.safeParse(props.call.args).data?.query ?? null)
const output = computed(() => WebSearchOutputSchema.safeParse(props.result?.content).data ?? null)
const failure = computed(() => ToolErrorSchema.safeParse(props.result?.content).data?.error ?? null)
// A spent budget is not a failure: the tool stopped on purpose, so it reads as a plain note.
const refusal = computed(() => ToolRefusalSchema.safeParse(props.result?.content).data?.refused ?? null)
// Neither shape matched a result that exists: show the raw payload rather than an empty card.
const unreadable = computed(() => props.result !== null && !output.value && !failure.value && !refusal.value)
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  div(v-if="refusal" class="oc-turn-row bg-muted text-sm text-muted-foreground")
    SearchIcon(class="size-4 shrink-0")
    span {{ refusal }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 联网搜索失败
    AlertDescription {{ failure }}
  template(v-else-if="!result")
    .oc-turn-row.text-sm.text-muted-foreground
      Spinner(class="size-4 shrink-0")
      span 正在搜索{{ query ? ` “${query}”` : '' }}
  Collapsible(v-else-if="output")
    CollapsibleTrigger(class="oc-turn-row text-sm hover:bg-accent")
      SearchIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate.text-left 搜索“{{ output.query }}”
      Badge(variant="secondary" class="ml-auto shrink-0") {{ output.results.length }} 条
    CollapsibleContent
      p.px-2.py-3.text-sm.text-muted-foreground(v-if="!output.results.length") 没有搜到相关结果。
      ol.flex.flex-col.gap-3.px-2.py-3(v-else)
        li.flex.flex-col.gap-1(v-for="(item, index) in output.results" :key="`${index}-${item.url}`")
          a.text-sm.font-medium.underline-offset-2(
            :href="item.url" target="_blank" rel="noopener noreferrer" class="hover:underline")
            | {{ item.title || item.url }}
          .flex.min-w-0.items-center.gap-1.text-xs.text-muted-foreground
            img(v-if="item.site_icon" :src="item.site_icon" alt="" class="size-3 shrink-0 rounded-sm" loading="lazy" referrerpolicy="no-referrer")
            GlobeIcon(v-else class="size-3 shrink-0")
            span.truncate {{ item.site_name || hostOf(item.url) }}
            template(v-if="item.date")
              span.shrink-0 ·
              time.shrink-0(:datetime="item.date") {{ dateOf(item.date) }}
          p.line-clamp-4.text-sm.text-muted-foreground(v-if="item.content") {{ item.content }}
          details(v-if="item.full_text")
            summary.cursor-pointer.text-xs.text-muted-foreground 全文
            p.oc-scroll.mt-2.max-h-64.overflow-y-auto.whitespace-pre-wrap.text-sm.text-muted-foreground {{ item.full_text }}
  pre.oc-scroll.max-h-64.overflow-auto.rounded-md.bg-muted.p-3.text-xs(v-else-if="unreadable")
    | {{ JSON.stringify(result?.content, null, 2) }}
</template>
