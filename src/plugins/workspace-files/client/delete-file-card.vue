<script setup lang="ts">
import { computed } from 'vue'
import { Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { DeleteFileInput, DeleteFileOutput, WorkspaceToolError } from '../shared'
import { basename } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<DeleteFileInput>)
const content = computed(() => props.result?.content as DeleteFileOutput | WorkspaceToolError | undefined)
const output = computed(() => (content.value && 'deleted' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在删除 {{ basename(input.path ?? '') }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 删除未完成
    AlertDescription {{ failure.message }}
  .oc-turn-row.text-sm(v-else-if="output" :title="output.path")
    Trash2Icon(class="size-4 shrink-0 text-muted-foreground")
    span.min-w-0.truncate 已移入回收站 {{ basename(output.path) }}
    Badge(v-if="output.deleted.length > 1" variant="secondary" class="ml-auto shrink-0") {{ output.deleted.length }} 个文件
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
