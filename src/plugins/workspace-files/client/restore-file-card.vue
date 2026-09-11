<script setup lang="ts">
import { computed } from 'vue'
import { HistoryIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { RestoreFileInput, RestoreFileOutput, WorkspaceToolError } from '../shared'
import { basename, formatBytes } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<RestoreFileInput>)
const content = computed(() => props.result?.content as RestoreFileOutput | WorkspaceToolError | undefined)
const output = computed(() => (content.value && 'restoredFrom' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在还原 {{ basename(input.path ?? '') }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 还原未完成
    AlertDescription {{ failure.message }}
  .oc-turn-row.text-sm(v-else-if="output" :title="`${output.sourcePath} v${output.restoredFrom} → ${output.path}`")
    HistoryIcon(class="size-4 shrink-0 text-muted-foreground")
    span.min-w-0.truncate 已还原 {{ basename(output.sourcePath) }} 的 v{{ output.restoredFrom }} 为 {{ basename(output.path) }}
    Badge(variant="secondary" class="ml-auto shrink-0") {{ formatBytes(output.fileSize) }} · {{ output.totalLines }} 行
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
