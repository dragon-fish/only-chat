<script setup lang="ts">
import { computed } from 'vue'
import { TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Spinner } from '@/client/ui/spinner'
import FileThumb from '@/client/components/file-thumb.vue'
import { fileRefLabel } from '@/client/components/workspace-files'
import { useAttachmentUrl } from '@/client/lib/audit-context'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { FileToolError, ViewFileInput, ViewFileOutput } from '../shared'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<ViewFileInput>)
const attachmentUrl = useAttachmentUrl()
const content = computed(() => props.result?.content as ViewFileOutput | FileToolError | undefined)
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const receipt = computed(() => (content.value && 'file' in content.value ? content.value : null))
/** The file the model was shown; the part carries its attachment, not the content. */
const shown = computed(() => props.result?.attachments?.[0] ?? null)
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在查看 {{ fileRefLabel(input.file ?? '') }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 查看未完成
    AlertDescription {{ failure.message }}
  .flex.flex-col.gap-2(v-else-if="receipt")
    .oc-turn-row.text-sm(:title="receipt.file")
      FileThumb(:mime="receipt.mime")
      span.min-w-0.truncate 已查看 {{ fileRefLabel(input.file ?? receipt.file) }}
      span.shrink-0.text-xs.text-muted-foreground {{ receipt.mime }}
      a.shrink-0.text-xs.underline(v-if="shown !== null" :href="attachmentUrl(shown)" target="_blank" rel="noopener") 查看文件
    img.max-h-40.w-fit.rounded-md.border(v-if="shown !== null && receipt.mime.startsWith('image/')" :src="attachmentUrl(shown)" :alt="receipt.file" loading="lazy")
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
