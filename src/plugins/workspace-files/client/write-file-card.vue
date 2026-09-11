<script setup lang="ts">
import { computed } from 'vue'
import { FilePlusIcon, FilePenIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { WriteFileInput, WriteFileOutput, WorkspaceToolError } from '../shared'
import { basename, formatBytes } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<WriteFileInput>)
const content = computed(() => props.result?.content as WriteFileOutput | WorkspaceToolError | undefined)
const output = computed(() => (content.value && 'operation' in content.value ? content.value : null))
/**
 * A rejected write is a fact the model acts on, not a malfunction. It only happens now when the
 * caller named a version that no longer matches — someone else moved the file.
 */
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const path = computed(() => output.value?.path ?? input.value.path ?? '')

const label = computed(() => {
  const value = output.value
  if (!value) return ''
  if (value.operation === 'created') return '已创建'
  return value.replacedVersion === null ? '已更新' : `已覆盖 v${value.replacedVersion}`
})

/** Overwriting a version this turn never read is worth saying out loud; the content is recoverable. */
const unseen = computed(() => output.value?.staleReadVersion ?? null)
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在写入 {{ basename(path) }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 写入未完成
    AlertDescription {{ failure.message }}
  template(v-else-if="output")
    .oc-turn-row.text-sm(:title="output.path")
      FilePlusIcon(v-if="output.operation === 'created'" class="size-4 shrink-0 text-muted-foreground")
      FilePenIcon(v-else class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate {{ label }} {{ basename(output.path) }}
      Badge(variant="secondary" class="ml-auto shrink-0") {{ formatBytes(output.fileSize) }} · {{ output.totalLines }} 行 · v{{ output.version }}
    .oc-turn-row.text-xs.text-amber-600(v-if="unseen !== null" class="dark:text-amber-400")
      TriangleAlertIcon(class="size-3.5 shrink-0")
      span 覆盖了未读过的 v{{ output.replacedVersion }}（读取时为 v{{ unseen }}），可用 restore_file 找回
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
