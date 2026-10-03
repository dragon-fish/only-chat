<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RefreshCwIcon, RotateCcwIcon, Trash2Icon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Button } from '@/client/ui/button'
import { Checkbox } from '@/client/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/client/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/client/ui/tabs'
import { Skeleton } from '@/client/ui/skeleton'
import WorkspaceFilePreview from '@/client/components/workspace-file-preview.vue'
import { fileIcon, formatFileSize, type PreviewTarget } from '@/client/components/workspace-files'
import { api, type WorkspaceScopeLabels } from '@/client/lib/api'
import type { FileRecord } from '@/shared/workspace-files'

type TrashRecord = FileRecord & { deletedAt: number }
type Tab = 'files' | 'trash' | 'orphans'

const files = ref<FileRecord[]>([])
const trash = ref<TrashRecord[]>([])
const orphans = ref<TrashRecord[]>([])
const scopes = ref<WorkspaceScopeLabels>({ projects: {}, conversations: {} })
const trashScopes = ref<WorkspaceScopeLabels>({ projects: {}, conversations: {} })
const loading = ref(true)
const busyId = ref<number | null>(null)
const bulkBusy = ref(false)
const preview = ref<PreviewTarget | null>(null)
const tab = ref<Tab>('files')
const selected = ref(new Set<number>())

/** Largest first: this view exists to answer where the space went. */
const sortedFiles = computed(() => [...files.value].sort((a, b) => b.fileSize - a.fileSize))
const totalBytes = computed(() => files.value.reduce((sum, file) => sum + file.fileSize, 0))
const trashBytes = computed(() => trash.value.reduce((sum, file) => sum + file.fileSize, 0))
const orphanBytes = computed(() => orphans.value.reduce((sum, file) => sum + file.fileSize, 0))

/** The rows the checkboxes act on, so select-all never reaches a tab you cannot see. */
const rows = computed<FileRecord[]>(() =>
  tab.value === 'files' ? sortedFiles.value : tab.value === 'trash' ? trash.value : orphans.value)
const selectedRows = computed(() => rows.value.filter(row => selected.value.has(row.id)))
const selectedBytes = computed(() => selectedRows.value.reduce((sum, file) => sum + file.fileSize, 0))
const headerChecked = computed<boolean | 'indeterminate'>(() => {
  if (selectedRows.value.length === 0) return false
  return selectedRows.value.length === rows.value.length ? true : 'indeterminate'
})
const busy = computed(() => busyId.value !== null || bulkBusy.value)

// A selection is about rows on screen. Changing tab or reloading makes it meaningless, and acting
// on ids the user can no longer see is how a batch delete surprises someone.
watch(tab, () => { selected.value = new Set() })

function toggleAll(value: boolean | 'indeterminate') {
  selected.value = value === true ? new Set(rows.value.map(row => row.id)) : new Set()
}

function toggleRow(id: number, value: boolean | 'indeterminate') {
  const next = new Set(selected.value)
  if (value === true) next.add(id)
  else next.delete(id)
  selected.value = next
}

function scopeLabel(file: FileRecord, labels: WorkspaceScopeLabels): string {
  if (file.mount === 'memory/user') return '记忆'
  if (file.mount === 'memory/project') return `${labels.projects[String(file.projectId)] ?? `Project ${file.projectId}`} · 记忆`
  if (file.projectId !== null) return labels.projects[String(file.projectId)] ?? `Project ${file.projectId}`
  if (file.conversationId !== null) return labels.conversations[String(file.conversationId)] ?? `会话 ${file.conversationId}`
  return '未知位置'
}

async function load() {
  loading.value = true
  try {
    const [live, deleted, stranded] = await Promise.all([
      api.workspaceFiles(), api.workspaceTrash(), api.workspaceOrphans(),
    ])
    files.value = live.files
    scopes.value = live.scopes
    trash.value = deleted.files
    trashScopes.value = deleted.scopes
    orphans.value = stranded.files
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
  finally {
    selected.value = new Set()
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

/**
 * Runs one request per selected row and reports what actually happened. Sequential on purpose: the
 * count in the toast has to be the number that succeeded, and a partial failure must still leave
 * the rest done rather than aborting the batch.
 */
async function bulk(run: (file: FileRecord) => Promise<number>, describe: (count: number, bytes: number) => string) {
  const targets = selectedRows.value
  if (targets.length === 0) return
  bulkBusy.value = true
  let done = 0
  let bytes = 0
  const failures: string[] = []
  try {
    for (const file of targets) {
      try {
        bytes += await run(file)
        done++
      }
      catch (error) {
        failures.push(`${file.relativePath}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (done > 0) toast.success(describe(done, bytes))
    if (failures.length > 0) toast.error(`${failures.length} 个未能完成：${failures[0]}`)
    await load()
  }
  finally {
    bulkBusy.value = false
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
const clearOrphans = () => act(null, async () => {
  const { files: count, bytes } = await api.purgeWorkspaceOrphans()
  return `已清理 ${count} 个悬空文件，释放 ${formatFileSize(bytes)}`
})

const bulkRemove = () => bulk(
  async (file) => { await api.deleteWorkspaceFile(file.id); return 0 },
  count => `已将 ${count} 个文件移入回收站`,
)
const bulkRestore = () => bulk(
  async (file) => { await api.restoreWorkspaceFile(file.id); return 0 },
  count => `已还原 ${count} 个文件`,
)
const bulkPurge = () => bulk(
  async (file) => (await api.purgeWorkspaceFile(file.id)).bytes,
  (count, bytes) => `已彻底删除 ${count} 个文件，释放 ${formatFileSize(bytes)}`,
)

function selectTab(value: unknown) {
  if (value === 'files' || value === 'trash' || value === 'orphans') tab.value = value
}
</script>

<template lang="pug">
.flex.flex-col.gap-3
  .flex.flex-wrap.items-center.justify-between.gap-2
    Tabs(:model-value="tab" @update:model-value="selectTab")
      TabsList
        TabsTrigger(value="files" class="min-h-10 md:min-h-7") 文件 {{ files.length }}
        TabsTrigger(value="trash" class="min-h-10 md:min-h-7") 回收站 {{ trash.length }}
        TabsTrigger(value="orphans" class="min-h-10 md:min-h-7") 悬空文件 {{ orphans.length }}
    .flex.items-center.gap-2
      p(class="text-muted-foreground text-xs")
        template(v-if="tab === 'files'") 共 {{ formatFileSize(totalBytes) }}
        template(v-else-if="tab === 'trash'") 可释放 {{ formatFileSize(trashBytes) }}
        template(v-else) 可释放 {{ formatFileSize(orphanBytes) }}
      Button(type="button" variant="ghost" size="xs" class="min-h-10 md:min-h-7" :disabled="loading || busy" @click="load")
        RefreshCwIcon(data-icon="inline-start")
        | 刷新

  .flex.flex-col.gap-2(v-if="loading")
    Skeleton(v-for="n in 3" :key="n" class="h-8 w-full")

  template(v-else)
    //- One bar for every tab: what it offers changes, where it sits does not.
    .flex.flex-wrap.items-center.justify-between.gap-2.rounded-md.px-3.py-2(v-if="selectedRows.length" class="bg-muted/40")
      p(class="text-xs") 已选 {{ selectedRows.length }} 项 · {{ formatFileSize(selectedBytes) }}
      .flex.items-center.gap-2
        Button(type="button" variant="ghost" size="xs" class="min-h-10 md:min-h-7" :disabled="bulkBusy" @click="selected = new Set()") 取消选择
        Button(
          v-if="tab === 'files'" type="button" variant="outline" size="xs" class="min-h-10 md:min-h-7"
          :disabled="bulkBusy" @click="bulkRemove") 移入回收站
        Button(
          v-if="tab === 'trash'" type="button" variant="outline" size="xs" class="min-h-10 md:min-h-7"
          :disabled="bulkBusy" @click="bulkRestore") 还原
        AlertDialog(v-if="tab !== 'files'")
          AlertDialogTrigger(as-child)
            Button(type="button" variant="outline" size="xs" class="min-h-10 md:min-h-7" :disabled="bulkBusy") 彻底删除
          AlertDialogContent
            AlertDialogHeader
              AlertDialogTitle 彻底删除选中的 {{ selectedRows.length }} 个文件？
              AlertDialogDescription
                | 连同它们的全部历史版本一起销毁，释放约 {{ formatFileSize(selectedBytes) }}。此操作无法撤销。
            AlertDialogFooter
              AlertDialogCancel 取消
              AlertDialogAction(@click="bulkPurge") 彻底删除

    template(v-if="tab === 'files'")
      p(v-if="!files.length" class="text-muted-foreground py-6 text-center text-sm") 还没有任何文件。
      Table(v-else)
        TableHeader
          TableRow
            TableHead(class="w-8")
              Checkbox(:model-value="headerChecked" aria-label="全选" @update:model-value="toggleAll")
            TableHead 文件
            TableHead(class="hidden md:table-cell") 位置
            TableHead(class="text-right") 大小
            TableHead
              span.sr-only 操作
        TableBody
          TableRow(v-for="file in sortedFiles" :key="file.id" :data-state="selected.has(file.id) ? 'selected' : undefined")
            TableCell
              Checkbox(
                :model-value="selected.has(file.id)" :aria-label="`选择 ${file.relativePath}`"
                @update:model-value="value => toggleRow(file.id, value)")
            TableCell
              button.flex.min-w-0.items-center.gap-2.text-left(type="button" :title="file.path" @click="preview = { kind: 'file', id: file.id }")
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

    template(v-else-if="tab === 'trash'")
      p(v-if="!trash.length" class="text-muted-foreground py-6 text-center text-sm") 回收站是空的。
      template(v-else)
        .flex.items-center.justify-between.gap-2
          p(class="text-muted-foreground text-xs") 删除超过 30 天的文件会被自动清除。
          AlertDialog
            AlertDialogTrigger(as-child)
              Button(type="button" variant="outline" size="xs" class="min-h-10 md:min-h-7" :disabled="busy") 清空回收站
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
              TableHead(class="w-8")
                Checkbox(:model-value="headerChecked" aria-label="全选" @update:model-value="toggleAll")
              TableHead 文件
              TableHead(class="hidden md:table-cell") 位置
              TableHead(class="hidden md:table-cell") 删除时间
              TableHead(class="text-right") 大小
              TableHead
                span.sr-only 操作
          TableBody
            TableRow(v-for="file in trash" :key="file.id" :data-state="selected.has(file.id) ? 'selected' : undefined")
              TableCell
                Checkbox(
                  :model-value="selected.has(file.id)" :aria-label="`选择 ${file.relativePath}`"
                  @update:model-value="value => toggleRow(file.id, value)")
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

    template(v-else)
      p(v-if="!orphans.length" class="text-muted-foreground py-6 text-center text-sm") 没有悬空文件。
      template(v-else)
        .flex.flex-wrap.items-center.justify-between.gap-2
          p(class="text-muted-foreground text-xs")
            | 这些文件原本属于已被删除的会话。它们无处可还原，超过 30 天会自动清除。
          AlertDialog
            AlertDialogTrigger(as-child)
              Button(type="button" variant="outline" size="xs" class="min-h-10 md:min-h-7" :disabled="busy") 全部清理
            AlertDialogContent
              AlertDialogHeader
                AlertDialogTitle 清理全部悬空文件？
                AlertDialogDescription
                  | 这会彻底删除 {{ orphans.length }} 个文件及其全部历史版本，释放约 {{ formatFileSize(orphanBytes) }}。此操作无法撤销。
              AlertDialogFooter
                AlertDialogCancel 取消
                AlertDialogAction(@click="clearOrphans") 彻底删除
        Table
          TableHeader
            TableRow
              TableHead(class="w-8")
                Checkbox(:model-value="headerChecked" aria-label="全选" @update:model-value="toggleAll")
              TableHead 文件
              TableHead(class="hidden md:table-cell") 失去归属的时间
              TableHead(class="text-right") 大小
              TableHead
                span.sr-only 操作
          TableBody
            TableRow(v-for="file in orphans" :key="file.id" :data-state="selected.has(file.id) ? 'selected' : undefined")
              TableCell
                Checkbox(
                  :model-value="selected.has(file.id)" :aria-label="`选择 ${file.relativePath}`"
                  @update:model-value="value => toggleRow(file.id, value)")
              TableCell
                .flex.min-w-0.items-center.gap-2
                  span.shrink-0(class="opacity-60 [&>svg]:size-4" v-html="fileIcon(file.relativePath)")
                  span(class="max-w-64 truncate font-mono text-sm") {{ file.relativePath }}
              TableCell(class="text-muted-foreground hidden whitespace-nowrap text-xs md:table-cell") {{ new Date(file.deletedAt).toLocaleString() }}
              TableCell(class="text-muted-foreground whitespace-nowrap text-right text-xs") {{ formatFileSize(file.fileSize) }}
              TableCell
                .flex.items-center.justify-end
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

WorkspaceFilePreview(:target="preview" @update:target="preview = $event")
</template>
