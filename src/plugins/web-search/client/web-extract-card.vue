<script setup lang="ts">
import { computed } from 'vue'
import { FileTextIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { ToolErrorSchema, ToolRefusalSchema, WebExtractInputSchema, WebExtractOutputSchema } from '../shared'
import { hostOf } from './format'

const props = defineProps<{ call: ToolCallPart; result: ToolResultPart | null }>()

const urls = computed(() => WebExtractInputSchema.safeParse(props.call.args).data?.urls ?? [])
const output = computed(() => WebExtractOutputSchema.safeParse(props.result?.content).data ?? null)
const failure = computed(() => ToolErrorSchema.safeParse(props.result?.content).data?.error ?? null)
// A spent budget is not a failure: the tool stopped on purpose, so it reads as a plain note.
const refusal = computed(() => ToolRefusalSchema.safeParse(props.result?.content).data?.refused ?? null)
const unreadable = computed(() => props.result !== null && !output.value && !failure.value && !refusal.value)
const summary = computed(() => {
  if (!output.value) return ''
  const ok = output.value.results.length
  const bad = output.value.failed.length
  return bad > 0 ? `${ok} 成功 · ${bad} 失败` : `${ok} 篇`
})
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  div(v-if="refusal" class="oc-turn-row bg-muted text-sm text-muted-foreground")
    FileTextIcon(class="size-4 shrink-0")
    span {{ refusal }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 网页抓取失败
    AlertDescription {{ failure }}
  template(v-else-if="!result")
    .oc-turn-row.text-sm.text-muted-foreground
      Spinner(class="size-4 shrink-0")
      span 正在抓取 {{ urls.length || '' }} 个网页
  Collapsible(v-else-if="output")
    CollapsibleTrigger(class="oc-turn-row text-sm hover:bg-accent")
      FileTextIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate.text-left 网页抓取
      Badge(variant="secondary" class="ml-auto shrink-0") {{ summary }}
    CollapsibleContent
      .flex.flex-col.gap-3.px-2.py-3
        details.flex.flex-col.gap-1(v-for="item in output.results" :key="item.url")
          summary.cursor-pointer.text-sm.font-medium
            | {{ item.title || hostOf(item.url) }}
          a.mt-1.block.truncate.text-xs.text-muted-foreground.underline-offset-2(
            :href="item.url" target="_blank" rel="noopener noreferrer" class="hover:underline")
            | {{ item.url }}
          p.oc-scroll.mt-2.max-h-64.overflow-y-auto.whitespace-pre-wrap.text-sm.text-muted-foreground
            | {{ item.content || '（正文为空）' }}
        .flex.flex-col.gap-1(v-if="output.failed.length")
          p.text-xs.font-medium.text-muted-foreground 抓取失败
          p.text-xs.text-muted-foreground(v-for="item in output.failed" :key="item.url")
            | {{ item.url }} — {{ item.error }}
  pre.oc-scroll.max-h-64.overflow-auto.rounded-md.bg-muted.p-3.text-xs(v-else-if="unreadable")
    | {{ JSON.stringify(result?.content, null, 2) }}
</template>
