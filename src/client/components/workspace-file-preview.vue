<script setup lang="ts">
import { ref, watch } from 'vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Skeleton } from '@/client/ui/skeleton'
import { api } from '@/client/lib/api'
import { formatFileSize, type FileRecord } from './workspace-files'

const props = defineProps<{ fileId: number | null }>()
const emit = defineEmits<{ 'update:fileId': [value: number | null] }>()

const record = ref<FileRecord | null>(null)
const content = ref('')
const loading = ref(false)
const error = ref<string | null>(null)

watch(() => props.fileId, async (fileId) => {
  record.value = null
  content.value = ''
  error.value = null
  if (fileId === null) return
  loading.value = true
  try {
    const body = await api.workspaceFile(fileId)
    // A second click while the first was in flight wins; this answer is already stale.
    if (props.fileId !== fileId) return
    record.value = body.record
    content.value = body.content
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取文件'
  }
  finally {
    loading.value = false
  }
}, { immediate: true })

function setOpen(open: boolean) {
  if (!open) emit('update:fileId', null)
}
</script>

<template lang="pug">
ResponsiveOverlay(
  mode="dialog" :open="fileId !== null" :title="record?.relativePath ?? '文件'" @update:open="setOpen")
  Alert(v-if="error" variant="destructive")
    AlertTitle 无法读取文件
    AlertDescription {{ error }}
  .flex.flex-col.gap-2(v-else-if="loading || !record")
    Skeleton(class="h-4 w-48")
    Skeleton(class="h-40 w-full")
  template(v-else)
    p(class="text-muted-foreground mb-3 text-xs")
      | 第 {{ record.version }} 版 · {{ formatFileSize(record.fileSize) }} · {{ record.totalLines }} 行 · 更新于 {{ new Date(record.updatedAt).toLocaleString() }}
    //- Source, never rendered: this text was written by a model and HTML must not execute here.
    //- Lines wrap rather than scroll sideways: a second scroll container inside the overlay's own
    //- makes the wheel land on whichever one the pointer happens to be over.
    pre.bg-muted.rounded-lg.p-3.text-xs(class="break-words whitespace-pre-wrap")
      code {{ content }}
  template(#footer)
    Button(v-if="record" as="a" variant="outline" class="min-h-10" :href="api.workspaceFileDownloadUrl(record.id)") 下载
</template>
