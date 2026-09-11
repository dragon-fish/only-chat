<script setup lang="ts">
import { computed } from 'vue'
import { FolderIcon, FileIcon, HardDriveIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { ListFilesInput, ListFilesOutput, WorkspaceToolError } from '../shared'
import { basename, MOUNT_LABELS, MOUNT_STATUS_LABELS } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<ListFilesInput>)
const content = computed(() => props.result?.content as ListFilesOutput | WorkspaceToolError | undefined)
const output = computed(() => (content.value && 'entries' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const path = computed(() => output.value?.path ?? input.value.path ?? '/')

const summary = computed(() => {
  const value = output.value
  if (!value) return ''
  if (value.entries.length === 0) return '空'
  const count = `${value.entries.length} 项`
  return value.truncated ? `${count} · 已截断` : count
})

function labelOf(entry: ListFilesOutput['entries'][number]): string {
  if (entry.type === 'mount') return MOUNT_LABELS[entry.path] ?? entry.path
  return basename(entry.path)
}
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在列出 {{ path }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 列出文件失败
    AlertDescription {{ failure.message }}
  Collapsible(v-else-if="output")
    CollapsibleTrigger(class="oc-turn-row text-sm hover:bg-accent" :title="output.path")
      FolderIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate.text-left 列出 {{ output.path }}
      Badge(variant="secondary" class="ml-auto shrink-0") {{ summary }}
    CollapsibleContent
      .flex.flex-col.px-2.py-2
        p.py-1.text-sm.text-muted-foreground(v-if="output.entries.length === 0") 这里还没有文件。
        .flex.items-center.gap-2.py-1.text-sm(v-for="entry in output.entries" :key="entry.path" :title="entry.path")
          HardDriveIcon(v-if="entry.type === 'mount'" class="size-4 shrink-0 text-muted-foreground")
          FolderIcon(v-else-if="entry.type === 'directory'" class="size-4 shrink-0 text-muted-foreground")
          FileIcon(v-else class="size-4 shrink-0 text-muted-foreground")
          span.min-w-0.truncate {{ labelOf(entry) }}
          //- A mount that is empty and one that is unavailable are different answers, not both "nothing".
          Badge(v-if="entry.status" variant="outline" class="ml-auto shrink-0") {{ MOUNT_STATUS_LABELS[entry.status] ?? entry.status }}
          span.ml-auto.shrink-0.text-xs.text-muted-foreground(v-else-if="entry.version !== undefined") v{{ entry.version }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
