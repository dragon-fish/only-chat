<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RefreshCwIcon, RotateCcwIcon, Trash2Icon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Button } from '@/client/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/client/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/client/ui/tabs'
import { Skeleton } from '@/client/ui/skeleton'
import WorkspaceFilePreview from '@/client/components/workspace-file-preview.vue'
import { fileIcon, formatFileSize } from '@/client/components/workspace-files'
import { api, type WorkspaceScopeLabels } from '@/client/lib/api'
import type { FileRecord } from '@/shared/workspace-files'

type TrashRecord = FileRecord & { deletedAt: number }

const files = ref<FileRecord[]>([])
const trash = ref<TrashRecord[]>([])
const scopes = ref<WorkspaceScopeLabels>({ projects: {}, conversations: {} })
const trashScopes = ref<WorkspaceScopeLabels>({ projects: {}, conversations: {} })
const loading = ref(true)
const busyId = ref<number | null>(null)
const previewId = ref<number | null>(null)
const tab = ref<'files' | 'trash'>('files')

/** Largest first: this view exists to answer where the space went. */
const sortedFiles = computed(() => [...files.value].sort((a, b) => b.fileSize - a.fileSize))
const totalBytes = computed(() => files.value.reduce((sum, file) => sum + file.fileSize, 0))
const trashBytes = computed(() => trash.value.reduce((sum, file) => sum + file.fileSize, 0))

function scopeLabel(file: FileRecord, labels: WorkspaceScopeLabels): string {
  if (file.projectId !== null) return labels.projects[String(file.projectId)] ?? `Project ${file.projectId}`
  if (file.conversationId !== null) return labels.conversations[String(file.conversationId)] ?? `会话 ${file.conversationId}`
  return '未知位置'
}

async function load() {
  loading.value = true
  try {
    const [live, deleted] = await Promise.all([api.workspaceFiles(), api.workspaceTrash()])
    files.value = live.files
    scopes.value = live.scopes
    trash.value = deleted.files
    trashScopes.value = deleted.scopes
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
  finally {
    loading.value = false
  }
}

onMounted(load)

async function act(id: number | null, run: () => Promise<string>) {
  busyId.value = id
  try {
    toast.success(await run())
    await load()
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
  finally {
    busyId.value = null
  }
}

const remove = (file: FileRecord) => act(file.id, async () => {
  await api.deleteWorkspaceFile(file.id)
  return `${file.relativePath} 已移入回收站`
})
const restore = (file: TrashRecord) => act(file.id, async () => {
  await api.restoreWorkspaceFile(file.id)
  return `${file.relativePath} 已还原`
})
const purge = (file: TrashRecord) => act(file.id, async () => {
  const { bytes } = await api.purgeWorkspaceFile(file.id)
  return `已彻底删除 ${file.relativePath}，释放 ${formatFileSize(bytes)}`
})
const emptyTrash = () => act(null, async () => {
  const { files: count, bytes } = await api.emptyWorkspaceTrash()
  return `已清空回收站：${count} 个文件，释放 ${formatFileSize(bytes)}`
})

function selectTab(value: unknown) {
  if (value === 'files' || value === 'trash') tab.value = value
}
</script>

<template lang="pug">
.flex.flex-col.gap-3
  .flex.flex-wrap.items-center.justify-between.gap-2
    Tabs(:model-value="tab" @update:model-value="selectTab")
      TabsList
        TabsTrigger(value="files" class="min-h-10 md:min-h-7") 文件 {{ files.length }}
        TabsTrigger(value="trash" class="min-h-10 md:min-h-7") 回收站 {{ trash.length }}
    .flex.items-center.gap-2
      p(class="text-muted-foreground text-xs")
        | {{ tab === 'files' ? `共 ${formatFileSize(totalBytes)}` : `可释放 ${formatFileSize(trashBytes)}` }}
      Button(type="button" variant="ghost" size="xs" class="min-h-10 md:min-h-7" :disabled="loading" @click="load")
        RefreshCwIcon(data-icon="inline-start")
        | 刷新

  .flex.flex-col.gap-2(v-if="loading")
    Skeleton(v-for="n in 3" :key="n" class="h-8 w-full")

  template(v-else-if="tab === 'files'")
    p(v-if="!files.length" class="text-muted-foreground py-6 text-center text-sm") 还没有任何文件。
    Table(v-else)
      TableHeader
        TableRow
          TableHead 文件
          TableHead(class="hidden md:table-cell") 位置
          TableHead(class="text-right") 大小
          TableHead
            span.sr-only 操作
      TableBody
        TableRow(v-for="file in sortedFiles" :key="file.id")
          TableCell
            button.flex.min-w-0.items-center.gap-2.text-left(type="button" :title="file.path" @click="previewId = file.id")
              span.shrink-0(class="[&>svg]:size-4" v-html="fileIcon(file.relativePath)")
              span(class="max-w-64 truncate font-mono text-sm") {{ file.relativePath }}
          TableCell(class="text-muted-foreground hidden max-w-48 truncate text-xs md:table-cell") {{ scopeLabel(file, scopes) }}
          TableCell(class="text-muted-foreground whitespace-nowrap text-right text-xs") {{ formatFileSize(file.fileSize) }}
          TableCell(class="text-right")
            Button(
              type="button" variant="ghost" size="icon-xs" class="size-8"
              :disabled="busyId === file.id" :aria-label="`删除 ${file.relativePath}`" title="移入回收站"
              @click="remove(file)")
              Trash2Icon(data-icon="inline-start")

  template(v-else)
    p(v-if="!trash.length" class="text-muted-foreground py-6 text-center text-sm") 回收站是空的。
    template(v-else)
      .flex.items-center.justify-between.gap-2
        p(class="text-muted-foreground text-xs") 删除超过 30 天的文件会被自动清除。
        AlertDialog
          AlertDialogTrigger(as-child)
            Button(type="button" variant="outline" size="xs" class="min-h-10 md:min-h-7" :disabled="busyId !== null") 清空回收站
          AlertDialogContent
            AlertDialogHeader
              AlertDialogTitle 清空回收站？
              AlertDialogDescription
                | 这会彻底删除 {{ trash.length }} 个文件及其全部历史版本，释放约 {{ formatFileSize(trashBytes) }}。此操作无法撤销。
            AlertDialogFooter
              AlertDialogCancel 取消
              AlertDialogAction(@click="emptyTrash") 彻底删除
      Table
        TableHeader
          TableRow
            TableHead 文件
            TableHead(class="hidden md:table-cell") 位置
            TableHead(class="hidden md:table-cell") 删除时间
            TableHead(class="text-right") 大小
            TableHead
              span.sr-only 操作
        TableBody
          TableRow(v-for="file in trash" :key="file.id")
            TableCell
              .flex.min-w-0.items-center.gap-2
                span.shrink-0(class="opacity-60 [&>svg]:size-4" v-html="fileIcon(file.relativePath)")
                span(class="max-w-64 truncate font-mono text-sm") {{ file.relativePath }}
            TableCell(class="text-muted-foreground hidden max-w-48 truncate text-xs md:table-cell") {{ scopeLabel(file, trashScopes) }}
            TableCell(class="text-muted-foreground hidden whitespace-nowrap text-xs md:table-cell") {{ new Date(file.deletedAt).toLocaleString() }}
            TableCell(class="text-muted-foreground whitespace-nowrap text-right text-xs") {{ formatFileSize(file.fileSize) }}
            TableCell
              .flex.items-center.justify-end
                Button(
                  type="button" variant="ghost" size="icon-xs" class="size-8"
                  :disabled="busyId === file.id" :aria-label="`还原 ${file.relativePath}`" title="还原"
                  @click="restore(file)")
                  RotateCcwIcon(data-icon="inline-start")
                AlertDialog
                  AlertDialogTrigger(as-child)
                    Button(
                      type="button" variant="ghost" size="icon-xs" class="size-8"
                      :disabled="busyId === file.id" :aria-label="`彻底删除 ${file.relativePath}`" title="彻底删除")
                      Trash2Icon(data-icon="inline-start")
                  AlertDialogContent
                    AlertDialogHeader
                      AlertDialogTitle 彻底删除 {{ file.relativePath }}？
                      AlertDialogDescription 连同它的全部历史版本一起销毁，无法撤销。
                    AlertDialogFooter
                      AlertDialogCancel 取消
                      AlertDialogAction(@click="purge(file)") 彻底删除

WorkspaceFilePreview(:file-id="previewId" @update:file-id="previewId = $event")
</template>
