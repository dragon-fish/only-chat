<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRightIcon, CodeIcon, GlobeIcon, TriangleAlertIcon } from '@lucide/vue'
import { api } from '@/client/lib/api'
import { useSyncStore } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { BrowserUseErrorSchema, BrowserUseInputSchema, BrowserUseOutputSchema, BrowserUseRefusalSchema } from '../shared'

const props = defineProps<{ call: ToolCallPart; result: ToolResultPart | null }>()
const sync = useSyncStore()

const code = computed(() => BrowserUseInputSchema.safeParse(props.call.args).data?.code ?? null)
const output = computed(() => BrowserUseOutputSchema.safeParse(props.result?.content).data ?? null)
const failure = computed(() => BrowserUseErrorSchema.safeParse(props.result?.content).data ?? null)
const refusal = computed(() => BrowserUseRefusalSchema.safeParse(props.result?.content).data?.refused ?? null)
const unreadable = computed(() => props.result !== null && !output.value && !failure.value && !refusal.value)
/** While the call runs, the live lines; afterwards the result's own log is the record. */
const liveLines = computed(() => sync.toolProgress.get(props.call.id) ?? [])
const logs = computed(() => output.value?.logs ?? failure.value?.logs ?? '')
const screenshots = computed(() => output.value?.screenshots ?? failure.value?.screenshots ?? [])
const pageLabel = computed(() => {
  const title = output.value?.title
  const url = output.value?.url ?? failure.value?.url
  return title || url || null
})
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  div(v-if="refusal" class="oc-turn-row bg-muted text-sm text-muted-foreground")
    GlobeIcon(class="size-4 shrink-0")
    span {{ refusal }}
  template(v-else-if="!result")
    .oc-turn-row.text-sm.text-muted-foreground
      Spinner(class="size-4 shrink-0")
      span 正在操作浏览器…
    pre.oc-scroll.max-h-48.overflow-auto.rounded-md.bg-muted.px-3.py-2.text-xs(v-if="liveLines.length") {{ liveLines.join('\\n') }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle {{ failure.timed_out ? '浏览器代码超时' : '浏览器代码出错' }}
    AlertDescription.whitespace-pre-wrap {{ failure.error }}
  Collapsible(v-else-if="output")
    CollapsibleTrigger(class="oc-turn-row group text-sm hover:bg-accent")
      GlobeIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.flex-1.truncate.text-left {{ pageLabel ? `操作了 ${pageLabel}` : '操作了浏览器' }}
      Badge(v-if="screenshots.length" variant="secondary" class="shrink-0") {{ screenshots.length }} 张截图
      //- Without it nothing says the row opens, which is most of why the code went unread.
      ChevronRightIcon(class="ml-1 size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90")
    CollapsibleContent.flex.flex-col.gap-2(class="mt-2")
      //- What it ran, beside what came back. Kept apart, the arguments read as a footnote to the
      //- card rather than as the other half of the same call.
      template(v-if="code")
        p(class="text-muted-foreground text-xs") 执行的代码
        pre.oc-scroll.max-h-96.overflow-auto.rounded-md.bg-muted.px-3.py-2.text-xs {{ code }}
      template(v-if="output.result")
        p(class="text-muted-foreground text-xs") 返回值
        pre.oc-scroll.max-h-64.overflow-auto.whitespace-pre-wrap.rounded-md.bg-muted.px-3.py-2.text-xs {{ output.result }}
  Alert(v-else-if="unreadable")
    TriangleAlertIcon
    AlertTitle 结果无法解析
    AlertDescription {{ JSON.stringify(result?.content) }}
  //- Running, failed or refused: there is no result row to fold into, and the code is still the
  //- only account of what was attempted.
  Collapsible(v-if="code && !output")
    CollapsibleTrigger(class="oc-turn-row group text-xs text-muted-foreground hover:bg-accent")
      CodeIcon(class="size-3.5 shrink-0")
      span.flex-1.text-left 查看代码
      ChevronRightIcon(class="ml-1 size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90")
    CollapsibleContent
      pre.oc-scroll.mt-1.max-h-96.overflow-auto.rounded-md.bg-muted.px-3.py-2.text-xs {{ code }}
  Collapsible(v-if="logs")
    CollapsibleTrigger(class="oc-turn-row group text-xs text-muted-foreground hover:bg-accent")
      span.flex-1.text-left 日志{{ (output?.logs_truncated || failure?.logs_truncated) ? '（已截断）' : '' }}
      ChevronRightIcon(class="ml-1 size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90")
    CollapsibleContent
      pre.oc-scroll.mt-1.max-h-64.overflow-auto.whitespace-pre-wrap.rounded-md.bg-muted.px-3.py-2.text-xs {{ logs }}
  .flex.flex-wrap.gap-2(v-if="screenshots.length")
    a(
      v-for="shot in screenshots" :key="shot.attachment_id" :href="api.attachmentUrl(shot.attachment_id)"
      target="_blank" rel="noopener" :title="shot.name" class="block overflow-hidden rounded-md border")
      img.h-24.w-auto.max-w-48.object-cover(:src="api.attachmentUrl(shot.attachment_id)" :alt="shot.name" loading="lazy")
</template>
