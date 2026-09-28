<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRightIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import FileThumb from '@/client/components/file-thumb.vue'
import { fileRefLabel } from '@/client/components/workspace-files'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { CopyFileInput, CopyFileOutput, WorkspaceToolError } from '../shared'
import { basename, formatBytes } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<CopyFileInput>)
const content = computed(() => props.result?.content as CopyFileOutput | WorkspaceToolError | undefined)
const output = computed(() => (content.value && 'path' in content.value && 'from' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在复制 {{ fileRefLabel(input.from ?? '') }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 复制未完成
    AlertDescription {{ failure.message }}
  .oc-turn-row.text-sm(v-else-if="output" :title="`${output.from} → ${output.path}`")
    FileThumb(:mime="output.mime" :name="output.path")
    span.min-w-0.truncate {{ fileRefLabel(output.from) }}
    ArrowRightIcon(class="size-3.5 shrink-0 text-muted-foreground")
    span.min-w-0.truncate {{ basename(output.path) }}
    Badge(variant="secondary" class="ml-auto shrink-0") {{ formatBytes(output.fileSize) }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
