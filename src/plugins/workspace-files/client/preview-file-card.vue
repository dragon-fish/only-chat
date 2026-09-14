<script setup lang="ts">
import { computed } from 'vue'
import { ExternalLinkIcon, EyeIcon, FileCodeIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { PreviewFileInput, PreviewFileOutput, WorkspaceToolError } from '../shared'
import { basename } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<PreviewFileInput>)
const content = computed(() => props.result?.content as PreviewFileOutput | WorkspaceToolError | undefined)
const output = computed(() => (content.value && 'url' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
/** Source-only is the default, and worth saying: the link looks the same either way. */
const sourceOnly = computed(() => output.value?.renders === 'text')
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在生成 {{ basename(input.path ?? '') }} 的预览链接
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 无法预览
    AlertDescription {{ failure.message }}
  .oc-turn-row.text-sm(v-else-if="output")
    component(:is="sourceOnly ? FileCodeIcon : EyeIcon" class="size-4 shrink-0 text-muted-foreground")
    a.min-w-0.truncate.underline-offset-4(
      :href="output.url" target="_blank" rel="noopener noreferrer"
      class="hover:underline" :title="output.path")
      | {{ basename(output.path) }}
    ExternalLinkIcon(class="size-3.5 shrink-0 text-muted-foreground")
    Badge(v-if="sourceOnly" variant="secondary" class="ml-auto shrink-0") 仅源码
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
