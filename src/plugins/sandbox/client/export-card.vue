<script setup lang="ts">
import { computed } from 'vue'
import { FileOutputIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { basename, formatBytes } from '@/plugins/workspace-files/client/format'
import type { SandboxExportInput, SandboxExportResult, SandboxToolError } from '../shared'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<SandboxExportInput>)
const content = computed(() => props.result?.content as SandboxExportResult | SandboxToolError | undefined)
const output = computed(() => (content.value && 'operation' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const OPERATIONS = { created: '新建', updated: '更新', replaced: '覆盖' } as const
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在导出 {{ basename(input.from ?? '') }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 导出未完成
    AlertDescription.whitespace-pre-wrap {{ failure.error }}
  .oc-turn-row.text-sm(v-else-if="output" :title="output.path")
    FileOutputIcon(class="size-4 shrink-0 text-muted-foreground")
    span.min-w-0.truncate 导出 {{ output.path }}
    span.shrink-0.text-xs.text-muted-foreground {{ OPERATIONS[output.operation] }}
    Badge(variant="secondary" class="ml-auto shrink-0") {{ formatBytes(output.size) }} · v{{ output.version }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
