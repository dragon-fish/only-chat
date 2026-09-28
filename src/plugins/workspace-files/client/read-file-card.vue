<script setup lang="ts">
import { computed } from 'vue'
import { FileCheckIcon, FileTextIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { useAttachmentUrl } from '@/client/lib/audit-context'
import FileThumb from '@/client/components/file-thumb.vue'
import { fileRefLabel } from '@/client/components/workspace-files'
import type { ReadDeliveredOutput, ReadFileInput, ReadFileOutput, ReadFileUnchangedOutput, WorkspaceToolError } from '../shared'
import { basename, formatBytes } from './format'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<ReadFileInput>)
const attachmentUrl = useAttachmentUrl()
const content = computed(() => props.result?.content as ReadFileOutput | ReadFileUnchangedOutput | ReadDeliveredOutput | WorkspaceToolError | undefined)
/** A binary file or a file reference, delivered to the model as a file rather than as lines. */
const receipt = computed(() => (content.value && 'file' in content.value ? content.value : null))
/** The file the model was shown, when it was; the part carries its attachment, not the content. */
const shownAttachment = computed(() => props.result?.attachments?.[0] ?? null)
const output = computed(() => (content.value && 'content' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
/** The turn asked for a file it had already read whole; the content it wanted is further up. */
const unchanged = computed(() => (content.value && 'unchanged' in content.value ? content.value : null))
const isImage = computed(() => receipt.value?.mime.startsWith('image/') ?? false)
const path = computed(() => output.value?.path ?? input.value.path ?? '')

/** What was actually returned, which is not always what was asked for. */
const range = computed(() => {
  const value = output.value
  if (!value) return ''
  if (value.empty) return '空文件'
  const end = value.startLine + value.returnedLines - 1
  const shown = value.returnedLines === value.totalLines ? `${value.totalLines} 行` : `${value.startLine}–${end} / ${value.totalLines} 行`
  return value.truncated ? `${shown} · 未读完` : shown
})
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在读取 {{ fileRefLabel(path) }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 读取未完成
    AlertDescription {{ failure.message }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else-if="unchanged" :title="unchanged.path")
    FileCheckIcon(class="size-4 shrink-0")
    span.min-w-0.truncate 未变 {{ basename(unchanged.path) }}
    Badge(variant="secondary" class="ml-auto shrink-0") v{{ unchanged.version }}
  .flex.flex-col.gap-2(v-else-if="receipt")
    .oc-turn-row.text-sm(:title="receipt.file")
      FileThumb(:mime="receipt.mime")
      span.min-w-0.truncate 已读取 {{ fileRefLabel(path || receipt.file) }}
      span.shrink-0.text-xs.text-muted-foreground {{ receipt.mime }}
      a.shrink-0.text-xs.underline(v-if="shownAttachment !== null" :href="attachmentUrl(shownAttachment)" target="_blank" rel="noopener") 查看文件
    img.max-h-40.w-fit.rounded-md.border(v-if="isImage && shownAttachment !== null" :src="attachmentUrl(shownAttachment)" :alt="receipt.file" loading="lazy")
  //- Content is collapsed by default: the model already has it, and a long file would bury the reply.
  Collapsible(v-else-if="output")
    CollapsibleTrigger(class="oc-turn-row text-sm hover:bg-accent" :title="output.path")
      FileTextIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate.text-left 读取 {{ basename(output.path) }}
      Badge(variant="secondary" class="ml-auto shrink-0") {{ range }}
    CollapsibleContent
      .flex.flex-col.gap-2.px-2.py-3
        p.text-xs.text-muted-foreground {{ output.path }} · {{ formatBytes(output.fileSize) }} · v{{ output.version }}
        p.text-sm.text-muted-foreground(v-if="output.empty") 这个文件是空的。
        pre.oc-scroll.max-h-80.overflow-auto.rounded.bg-muted.p-2(v-else)
          code.text-xs {{ output.content }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
