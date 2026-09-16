<script setup lang="ts">
import { computed } from 'vue'
import { FilePenLineIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { EditFileInput, EditFileOutput, WorkspaceToolError } from '../shared'
import { basename, formatBytes } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<EditFileInput>)
const content = computed(() => props.result?.content as EditFileOutput | WorkspaceToolError | undefined)
const output = computed(() => (content.value && 'replacements' in content.value ? content.value : null))
/**
 * A refused edit is a fact the model acts on: the text was not there, named more than one place, or
 * the file moved since it was read. None of those is a malfunction.
 */
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const path = computed(() => output.value?.path ?? input.value.path ?? '')
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在修改 {{ basename(path) }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 修改未完成
    AlertDescription {{ failure.message }}
  template(v-else-if="output")
    .oc-turn-row.text-sm(:title="output.path")
      FilePenLineIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate 已修改 {{ basename(output.path) }}
      Badge(variant="secondary" class="ml-auto shrink-0") {{ output.replacements }} 处 · {{ formatBytes(output.fileSize) }} · v{{ output.version }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
