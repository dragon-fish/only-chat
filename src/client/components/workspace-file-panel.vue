<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { DownloadIcon, EyeIcon, FileArchiveIcon, RefreshCwIcon, Trash2Icon } from '@lucide/vue'
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
import WorkspaceFilePreview from './workspace-file-preview.vue'
import { fileMetaLine, type FileRecord } from './workspace-files'

const props = defineProps<{
  /** Which mount to list. A conversation also shows the Project mount it can reach, read-only. */
  mount: 'project' | 'conversation'
  scopeId: number
}>()

const files = ref<FileRecord[]>([])
const projectFiles = ref<FileRecord[]>([])
/** The Project a conversation can also reach, so its archive can be offered beside its files. */
const projectId = ref<number | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const previewId = ref<number | null>(null)
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
    archiveUrl: projectId.value === null ? null : api.projectFilesArchiveUrl(projectId.value),
  }
  if (props.mount === 'project') return [project]
  const conversation = {
    key: 'conversation',
    title: '当前会话',
    hint: '只有这次会话能读到。',
    files: files.value,
    empty: '这次会话还没有自己的文件。',
    archiveUrl: api.conversationFilesArchiveUrl(props.scopeId),
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
      projectId.value = props.scopeId
    }
    else {
      const body = await api.conversationFiles(props.scopeId)
      files.value = body.files
      projectFiles.value = body.projectFiles
      projectId.value = body.projectId
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
      .flex.items-start.justify-between.gap-2
        div
          h3(class="text-sm font-medium") {{ group.title }}
          p(class="text-muted-foreground text-xs") {{ group.hint }}
        //- One archive keeps the relative layout: a page the model split across files stays usable.
        Button(
          v-if="group.files.length && group.archiveUrl" as="a" variant="ghost" size="xs"
          class="min-h-10 shrink-0 md:min-h-7" :href="group.archiveUrl" :title="`打包下载${group.title}的全部文件`")
          FileArchiveIcon(data-icon="inline-start")
          | 打包下载

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
              :disabled="busyId === file.id" :aria-label="`预览 ${file.relativePath}`" title="预览" @click="previewId = file.id")
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


WorkspaceFilePreview(:file-id="previewId" @update:file-id="previewId = $event")
</template>
