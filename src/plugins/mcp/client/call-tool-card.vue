<script setup lang="ts">
import { computed } from 'vue'
import { PlugIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import { useAttachmentUrl } from '@/client/lib/audit-context'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { McpCallToolInput, McpCallToolOutput, McpToolError } from '../shared'
import { useMcpServerNames } from './server-names'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()
const names = useMcpServerNames()
const attachmentUrl = useAttachmentUrl()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<McpCallToolInput>)
const content = computed(() => props.result?.content as McpCallToolOutput | McpToolError | undefined)
const output = computed(() => (content.value && 'tool_name' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const service = computed(() => names.value[input.value.service_id ?? ''] ?? input.value.service_id ?? 'MCP')
const title = computed(() => `${service.value} · ${input.value.tool_name ?? '…'}`)
const params = computed(() => JSON.stringify(input.value.params ?? {}, null, 2))
const extra = computed(() => {
  const value = output.value
  if (!value) return null
  const rest = { ...(value.other.length ? { other: value.other } : {}), ...(value.structured === undefined ? {} : { structured: value.structured }) }
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : null
})
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在调用 {{ title }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 调用 {{ title }} 失败
    AlertDescription {{ failure.message }}
  Collapsible(v-else-if="output")
    CollapsibleTrigger(class="oc-turn-row text-sm hover:bg-accent" :title="title")
      PlugIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate.text-left {{ title }}
      Badge(v-if="output.is_error" variant="destructive" class="ml-auto shrink-0") 服务报错
      Badge(v-else-if="output.images.length" variant="secondary" class="ml-auto shrink-0") {{ output.images.length }} 张图片
    CollapsibleContent
      .flex.flex-col.gap-3.px-2.py-2.text-xs
        div
          p.mb-1.font-medium.text-muted-foreground 参数
          pre(class="oc-scroll max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap") {{ params }}
        div(v-if="output.text")
          p.mb-1.font-medium.text-muted-foreground 结果{{ output.text_truncated ? `（已截断，原长 ${output.text_truncated.original_length} 字符）` : '' }}
          pre(class="oc-scroll max-h-80 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap") {{ output.text }}
        .flex.flex-wrap.gap-2(v-if="output.images.length")
          img(v-for="image in output.images" :key="image.attachment_id" :src="attachmentUrl(image.attachment_id)" alt="" class="max-h-60 rounded border")
        div(v-if="extra")
          p.mb-1.font-medium.text-muted-foreground 其他内容
          pre(class="oc-scroll max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono whitespace-pre-wrap") {{ extra }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span.min-w-0.truncate {{ title }}
</template>
