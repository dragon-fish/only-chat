<script setup lang="ts">
import { computed } from 'vue'
import { FileCheckIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Spinner } from '@/client/ui/spinner'
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
    span.min-w-0.truncate 正在查看 {{ input.file }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 查看未完成
    AlertDescription {{ failure.message }}
  .flex.flex-col.gap-2(v-else-if="receipt")
    .oc-turn-row.text-sm
      FileCheckIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate.font-mono 已查看 {{ receipt.file }}
      span.text-xs.text-muted-foreground {{ receipt.mime }}
    img.max-h-40.w-fit.rounded-md.border(v-if="shown !== null && receipt.mime.startsWith('image/')" :src="attachmentUrl(shown)" :alt="receipt.file" loading="lazy")
</template>
