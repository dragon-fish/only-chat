<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileIcon } from '@lucide/vue'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { api } from '@/client/lib/api'
import WorkspaceFilePreview from '@/client/components/workspace-file-preview.vue'
import type { PreviewTarget } from '@/client/components/workspace-files'
import WorkspaceFilesDialog from '@/client/components/workspace-files-dialog.vue'
import type { Message } from '@/shared/models'
import { basename, formatBytes } from './format'
import { filesWrittenInTurn, type TurnFile } from './turn-files'

const props = defineProps<{ message: Message }>()

/** Enough to see what came out of the turn; the rest is one click away. */
const PREVIEW_LIMIT = 3

const files = computed(() => filesWrittenInTurn(props.message.parts))
const shown = computed(() => files.value.slice(0, PREVIEW_LIMIT))
const preview = ref<PreviewTarget | null>(null)
const resolving = ref<string | null>(null)
const error = ref<string | null>(null)

function scopeLabel(path: string): string {
  return path.startsWith('/project/') ? '项目' : '会话'
}

/**
 * Tool results name a file by path, which is all the model needs. Opening one needs the row id, so
 * it is looked up on demand — a list request per click beats one per rendered message.
 */
async function open(file: TurnFile) {
  resolving.value = file.path
  error.value = null
  try {
    const body = await api.conversationFiles(props.message.conversation_id)
    const match = [...body.files, ...body.projectFiles].find(record => record.path === file.path)
    if (!match) {
      error.value = `${basename(file.path)} 已不在工作区`
      return
    }
    preview.value = { kind: 'file', id: match.id }
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法打开文件'
  }
  finally {
    resolving.value = null
  }
}
</script>

<template lang="pug">
.flex.flex-col.gap-1(v-if="files.length")
  p(class="text-muted-foreground text-xs") 本轮产出的文件
  .flex.flex-wrap.items-center.gap-1
    Button(
      v-for="file in shown" :key="file.path" type="button" variant="outline" size="xs"
      class="min-h-10 max-w-full gap-1.5 md:min-h-7" :disabled="resolving === file.path"
      :title="file.path" @click="open(file)")
      FileIcon(data-icon="inline-start" class="text-muted-foreground")
      span.min-w-0.truncate {{ basename(file.path) }}
      Badge(variant="secondary" class="shrink-0") {{ scopeLabel(file.path) }} · {{ formatBytes(file.fileSize) }}
    WorkspaceFilesDialog(mount="conversation" :scope-id="message.conversation_id")
      template(#trigger)
        Button(type="button" variant="ghost" size="xs" class="min-h-10 md:min-h-7")
          | {{ files.length > shown.length ? `查看全部 ${files.length} 个` : '查看全部' }}
  p(v-if="error" class="text-destructive text-xs") {{ error }}

WorkspaceFilePreview(:target="preview" @update:target="preview = $event")
</template>
