<script setup lang="ts">
import { computed } from 'vue'
import { TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import FileThumb from '@/client/components/file-thumb.vue'
import { fileLabel } from '@/client/components/workspace-files'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { AnalyzeFileInput, AnalyzeFileOutput, FileToolError } from '../shared'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<AnalyzeFileInput>)
const content = computed(() => props.result?.content as AnalyzeFileOutput | FileToolError | undefined)
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const output = computed(() => (content.value && 'text' in content.value ? content.value : null))
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在分析 {{ fileLabel(input.file) }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 文件分析未完成
    AlertDescription {{ failure.message }}
  //- Collapsed by default: the model already has the text, and a long analysis would bury the reply.
  Collapsible(v-else-if="output")
    CollapsibleTrigger(class="oc-turn-row text-sm hover:bg-accent")
      FileThumb(:mime="output.mime" :name="output.name ?? undefined")
      span.min-w-0.truncate.text-left 分析 {{ fileLabel(input.file, output.name, output.mime) }}
      Badge(v-if="output.truncated" variant="secondary" class="ml-auto shrink-0") 结果不完整
    CollapsibleContent
      .flex.flex-col.gap-2.px-2.py-3
        p.text-xs.text-muted-foreground {{ output.mime }}
        p.text-sm(v-if="input.question")
          span.text-muted-foreground 问题：
          | {{ input.question }}
        p.text-xs.text-muted-foreground(v-if="output.truncated") 输出达到模型长度限制，以下内容不完整。
        pre.oc-scroll.max-h-96.overflow-auto.rounded.bg-muted.p-2.whitespace-pre-wrap.break-words.font-sans.text-sm {{ output.text }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
