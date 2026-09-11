<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRightIcon, FolderInputIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { RenameFileInput, RenameFileOutput, WorkspaceToolError } from '../shared'
import { basename } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<RenameFileInput>)
const content = computed(() => props.result?.content as RenameFileOutput | WorkspaceToolError | undefined)
const output = computed(() => (content.value && 'moved' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在移动 {{ basename(input.path ?? '') }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 移动未完成
    AlertDescription {{ failure.message }}
  .oc-turn-row.text-sm(v-else-if="output" :title="`${output.fromPath} → ${output.path}`")
    FolderInputIcon(class="size-4 shrink-0 text-muted-foreground")
    span.min-w-0.truncate {{ basename(output.fromPath) }}
    ArrowRightIcon(class="size-3.5 shrink-0 text-muted-foreground")
    span.min-w-0.truncate {{ basename(output.path) }}
    Badge(v-if="output.moved.length > 1" variant="secondary" class="ml-auto shrink-0") {{ output.moved.length }} 个文件
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
