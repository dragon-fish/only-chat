<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { DownloadIcon, EyeIcon, RefreshCwIcon, Trash2Icon } from '@lucide/vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { Skeleton } from '@/client/ui/skeleton'
import { api } from '@/client/lib/api'
import { fileMetaLine, formatFileSize, type FileRecord } from './workspace-files'

const props = defineProps<{
  /** Which mount to list. A conversation also shows the Project mount it can reach, read-only. */
  mount: 'project' | 'conversation'
  scopeId: number
}>()

const files = ref<FileRecord[]>([])
const projectFiles = ref<FileRecord[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const preview = ref<{ record: FileRecord, content: string } | null>(null)
const previewError = ref<string | null>(null)
const busyId = ref<number | null>(null)

/**
 * Mount paths are the model's addressing scheme, not a concept to teach a reader. The panel says
 * where a file lives by grouping, and names it by the path inside that group.
 */
const sections = computed(() => {
  const project = {
    key: 'project',
    title: '当前项目',
    hint: '这个 Project 下的所有会话都能读到。',
    files: props.mount === 'project' ? files.value : projectFiles.value,
    empty: '这个 Project 还没有文件。',
  }
  if (props.mount === 'project') return [project]
  const conversation = {
    key: 'conversation',
    title: '当前会话',
    hint: '只有这次会话能读到。',
    files: files.value,
    empty: '这次会话还没有自己的文件。',
  }
  // A conversation outside a Project has no second group, and one whose Project is empty gains
  // nothing from an empty heading.
  return projectFiles.value.length > 0 ? [conversation, project] : [conversation]
})

async function load() {
  loading.value = true
  error.value = null
  try {
    if (props.mount === 'project') {
      files.value = (await api.projectFiles(props.scopeId)).files
      projectFiles.value = []
    }
    else {
      const body = await api.conversationFiles(props.scopeId)
      files.value = body.files
      projectFiles.value = body.projectFiles
    }
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法加载文件列表'
  }
  finally {
    loading.value = false
  }
}

watch(() => [props.mount, props.scopeId] as const, load, { immediate: true })

async function openPreview(record: FileRecord) {
  busyId.value = record.id
  previewError.value = null
  try {
    const body = await api.workspaceFile(record.id)
    preview.value = { record: body.record, content: body.content }
  }
  catch (cause) {
    previewError.value = cause instanceof Error ? cause.message : '无法读取文件'
  }
  finally {
    busyId.value = null
  }
}

async function remove(record: FileRecord) {
  busyId.value = record.id
  try {
    await api.deleteWorkspaceFile(record.id)
    // Deleting frees the path, so a stale row would claim a name that is available again.
    await load()
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法删除文件'
  }
  finally {
    busyId.value = null
  }
}

function setPreviewOpen(open: boolean) {
  if (!open) preview.value = null
}
</script>

<template lang="pug">
.flex.flex-col.gap-3
  .flex.items-center.justify-end
    Button(type="button" variant="ghost" size="xs" class="min-h-10 md:min-h-6" :disabled="loading" @click="load")
      RefreshCwIcon(data-icon="inline-start")
      | 刷新

  Alert(v-if="error" variant="destructive")
    AlertTitle 无法加载文件
    AlertDescription
      p {{ error }}
      Button(variant="outline" class="mt-2 min-h-10" @click="load") 重试

  .flex.flex-col.gap-2(v-else-if="loading && !files.length")
    Skeleton(v-for="n in 2" :key="n" class="h-14 w-full")

  template(v-else)
    section.flex.flex-col.gap-2(v-for="group in sections" :key="group.key")
      div
        h3(class="text-sm font-medium") {{ group.title }}
        p(class="text-muted-foreground text-xs") {{ group.hint }}

      Empty(v-if="!group.files.length" class="border-border rounded-lg border border-dashed py-6")
        EmptyHeader
          EmptyTitle(class="text-sm") 暂无文件
          EmptyDescription(class="text-xs") {{ group.empty }}

      ItemGroup(v-else class="gap-1")
        Item(v-for="file in group.files" :key="file.id" variant="outline" size="sm")
          ItemContent(class="min-w-0")
            ItemTitle(class="font-mono") {{ file.relativePath }}
            ItemDescription(class="text-xs") {{ fileMetaLine(file) }}
          ItemActions(class="gap-1")
            Button(
              type="button" variant="ghost" size="icon-xs" class="size-10 md:size-8"
              :disabled="busyId === file.id" :aria-label="`预览 ${file.relativePath}`" title="预览" @click="openPreview(file)")
              EyeIcon(data-icon="inline-start")
            Button(
              as="a" variant="ghost" size="icon-xs" class="size-10 md:size-8"
              :href="api.workspaceFileDownloadUrl(file.id)" :aria-label="`下载 ${file.relativePath}`" title="下载")
              DownloadIcon(data-icon="inline-start")
            AlertDialog
              AlertDialogTrigger(as-child)
                Button(
                  type="button" variant="ghost" size="icon-xs" class="size-10 md:size-8"
                  :disabled="busyId === file.id" :aria-label="`删除 ${file.relativePath}`" title="删除")
                  Trash2Icon(data-icon="inline-start")
              AlertDialogContent
                AlertDialogHeader
                  AlertDialogTitle 删除 {{ file.relativePath }}？
                  AlertDialogDescription 模型将不再看到这个文件，已保存的历史版本不会被清除。
                AlertDialogFooter
                  AlertDialogCancel 取消
                  AlertDialogAction(@click="remove(file)") 删除

  Alert(v-if="previewError" variant="destructive")
    AlertTitle 无法读取文件
    AlertDescription {{ previewError }}

ResponsiveOverlay(
  mode="dialog" :open="preview !== null" :title="preview?.record.relativePath ?? ''" @update:open="setPreviewOpen")
  template(v-if="preview")
    p(class="text-muted-foreground mb-3 text-xs")
      | 第 {{ preview.record.version }} 版 · {{ formatFileSize(preview.record.fileSize) }} · {{ preview.record.totalLines }} 行 · 更新于 {{ new Date(preview.record.updatedAt).toLocaleString() }}
    //- Source, never rendered: this text was written by a model and HTML must not execute here.
    pre.oc-scroll.bg-muted.overflow-x-auto.rounded-lg.p-3.text-xs
      code {{ preview.content }}
  template(#footer)
    Button(v-if="preview" as="a" variant="outline" class="min-h-10" :href="api.workspaceFileDownloadUrl(preview.record.id)") 下载
</template>
