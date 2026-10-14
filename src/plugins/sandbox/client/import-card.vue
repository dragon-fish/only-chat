<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRightIcon, FileInputIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import { fileLabel } from '@/client/components/workspace-files'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { formatBytes } from '@/plugins/workspace-files/client/format'
import type { SandboxImportInput, SandboxImportResult, SandboxToolError } from '../shared'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<SandboxImportInput>)
const content = computed(() => props.result?.content as SandboxImportResult | SandboxToolError | undefined)
const output = computed(() => (content.value && 'size' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const source = computed(() => fileLabel(input.value.from))
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在导入 {{ source }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 导入未完成
    AlertDescription.whitespace-pre-wrap {{ failure.error }}
  .oc-turn-row.text-sm(v-else-if="output" :title="output.to")
    FileInputIcon(class="size-4 shrink-0 text-muted-foreground")
    span.min-w-0.truncate 导入 {{ source }}
    ArrowRightIcon(class="size-3.5 shrink-0 text-muted-foreground")
    span.min-w-0.truncate.font-mono {{ output.to }}
    Badge(variant="secondary" class="ml-auto shrink-0") {{ formatBytes(output.size) }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
