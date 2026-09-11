<script setup lang="ts">
import { computed } from 'vue'
import { GlobeIcon, SearchIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Skeleton } from '@/client/ui/skeleton'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { ToolErrorSchema, ToolRefusalSchema, WebSearchInputSchema, WebSearchOutputSchema } from '../shared'
import { hostOf } from './format'

const props = defineProps<{ call: ToolCallPart; result: ToolResultPart | null }>()

const query = computed(() => WebSearchInputSchema.safeParse(props.call.args).data?.query ?? null)
const output = computed(() => WebSearchOutputSchema.safeParse(props.result?.content).data ?? null)
const failure = computed(() => ToolErrorSchema.safeParse(props.result?.content).data?.error ?? null)
// A spent budget is not a failure: the tool stopped on purpose, so it reads as a plain note.
const refusal = computed(() => ToolRefusalSchema.safeParse(props.result?.content).data?.refused ?? null)
// Neither shape matched a result that exists: show the raw payload rather than an empty card.
const unreadable = computed(() => props.result !== null && !output.value && !failure.value && !refusal.value)
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  div(v-if="refusal" class="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-sm text-muted-foreground")
    SearchIcon(class="size-4 shrink-0")
    span {{ refusal }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 联网搜索失败
    AlertDescription {{ failure }}
  template(v-else-if="!result")
    .flex.items-center.gap-2.text-sm.text-muted-foreground
      SearchIcon(class="size-4")
      span 正在搜索{{ query ? ` “${query}”` : '' }}…
    Skeleton(class="h-16 w-full")
  Collapsible(v-else-if="output")
    CollapsibleTrigger(class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent")
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
          .flex.items-center.gap-1.text-xs.text-muted-foreground
            GlobeIcon(class="size-3 shrink-0")
            span.truncate {{ hostOf(item.url) }}
          p.text-sm.text-muted-foreground(v-if="item.content") {{ item.content }}
  pre.oc-scroll.max-h-64.overflow-auto.rounded-md.bg-muted.p-3.text-xs(v-else-if="unreadable")
    | {{ JSON.stringify(result?.content, null, 2) }}
</template>
