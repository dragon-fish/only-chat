<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDownIcon, ChevronRightIcon, DownloadIcon, FileArchiveIcon, FileIcon, FolderIcon, RefreshCwIcon, Trash2Icon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Skeleton } from '@/client/ui/skeleton'
import { api } from '@/client/lib/api'
import type { ProjectedFileRecord } from '@/shared/workspace-files'
import { useSyncStore } from '@/client/stores/sync'
import ResponsiveOverlay from './layout/responsive-overlay.vue'
import FileAttachment from './file-attachment.vue'
import WorkspaceFilePreview from './workspace-file-preview.vue'
import { fileIcon, fileRowMeta, fileTreeRows, formatFileSize, type FileRecord } from './workspace-files'

const props = defineProps<{
  /** Which mount to list. A conversation also shows the Project mount it can reach. */
  mount: 'project' | 'conversation'
  scopeId: number
}>()

const files = ref<FileRecord[]>([])
const projectFiles = ref<FileRecord[]>([])
const uploads = ref<ProjectedFileRecord[]>([])
const artifacts = ref<ProjectedFileRecord[]>([])
const attachmentPreview = ref<ProjectedFileRecord | null>(null)
const sync = useSyncStore()
const filename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const projectedGroups = computed(() => props.mount === 'conversation' ? [
  { key: 'uploads', title: '/uploads', hint: '上传的附件 · 只读', files: uploads.value },
  { key: 'artifacts', title: '/artifacts', hint: '生成的附件 · 只读', files: artifacts.value },
] : [])
/** The Project a conversation can also reach, so its archive can be offered beside its files. */
const projectId = ref<number | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const previewId = ref<number | null>(null)
const busyId = ref<number | null>(null)
/** Open folders, keyed by `${section}:${path}` so two mounts cannot open each other's. */
const expanded = ref(new Set<string>(['uploads:', 'artifacts:']))

/**
 * Mount paths are the model's addressing scheme, not a concept to teach a reader. The panel says
 * where a file lives by grouping, and inside a group shows the folder shape the model wrote.
 */
const sections = computed(() => {
  const conversation = {
    key: 'conversation',
    title: '当前会话',
    hint: '只有这次会话能读到。',
    files: files.value,
    empty: '这次会话还没有自己的文件。',
    archive: api.conversationFilesArchiveUrl(props.scopeId),
  }
  const project = {
    key: 'project',
    title: '当前项目',
    hint: '这个 Project 下的所有会话都能读到。',
    files: props.mount === 'project' ? files.value : projectFiles.value,
    empty: '这个 Project 还没有文件。',
    archive: projectId.value === null ? null : api.projectFilesArchiveUrl(projectId.value),
  }
  // A conversation outside a Project has no second group, and one whose Project is empty gains
  // nothing from an empty heading.
  const groups = props.mount === 'project'
    ? [project]
    : projectFiles.value.length > 0 ? [conversation, project] : [conversation]

  return groups.map(group => ({
    ...group,
    rows: fileTreeRows(group.files, new Set(
      [...expanded.value].filter(key => key.startsWith(`${group.key}:`)).map(key => key.slice(group.key.length + 1)),
    )),
  }))
})

let loadEpoch = 0
async function load() {
  const epoch = ++loadEpoch
  loading.value = true
  error.value = null
  try {
    if (props.mount === 'project') {
      const body = await api.projectFiles(props.scopeId)
      if (epoch !== loadEpoch) return
      files.value = body.files
      uploads.value = []
      artifacts.value = []
      projectFiles.value = []
      projectId.value = props.scopeId
    }
    else {
      const body = await api.conversationFiles(props.scopeId)
      if (epoch !== loadEpoch) return
      uploads.value = body.uploads
      artifacts.value = body.artifacts
      files.value = body.files
      projectFiles.value = body.projectFiles
      projectId.value = body.projectId
    }
  }
  catch (cause) {
    if (epoch === loadEpoch) error.value = cause instanceof Error ? cause.message : '无法加载文件列表'
  }
  finally {
    if (epoch === loadEpoch) loading.value = false
  }
}

watch(() => [props.mount, props.scopeId] as const, () => {
  files.value = []; projectFiles.value = []; uploads.value = []; artifacts.value = []
  attachmentPreview.value = null
  void load()
}, { immediate: true })
// Observe attachment membership, not streaming text deltas.
watch(() => props.mount === 'conversation' ? [...(sync.messages.get(props.scopeId)?.values() ?? [])].flatMap(message =>
  message.parts.flatMap(part => part.type === 'image' || part.type === 'file'
    ? [`${message.id}:${part.attachment_id}`]
    : part.type === 'task_notification' ? [`${part.task_id}:${part.status}`] : []),
).join('|') : '', () => { void load() })

function toggleFolder(sectionKey: string, path: string) {
  const key = `${sectionKey}:${path}`
  const next = new Set(expanded.value)
  if (!next.delete(key)) next.add(key)
  expanded.value = next
}

function isOpen(sectionKey: string, path: string): boolean {
  return expanded.value.has(`${sectionKey}:${path}`)
}

/** A folder archive is what folders are for here: a page travels with the files it references. */
function folderArchive(archive: string | null, path: string): string | undefined {
  return archive === null ? undefined : `${archive}?prefix=${encodeURIComponent(`${path}/`)}`
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
</script>

<template lang="pug">
.flex.flex-col.gap-4
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
    Skeleton(v-for="n in 3" :key="n" class="h-8 w-full")

  template(v-else)
    section.flex.flex-col.gap-1(v-for="group in projectedGroups" :key="group.key")
      button.flex.min-h-10.items-center.gap-2.text-left(type="button" :aria-expanded="isOpen(group.key, '')" @click="toggleFolder(group.key, '')")
        ChevronDownIcon(v-if="isOpen(group.key, '')" class="size-4 shrink-0 text-muted-foreground")
        ChevronRightIcon(v-else class="size-4 shrink-0 text-muted-foreground")
        FolderIcon(class="size-4 shrink-0 text-muted-foreground")
        span.font-mono.text-sm {{ group.title }}
        span.text-xs.text-muted-foreground {{ group.files.length }}
      template(v-if="isOpen(group.key, '')")
        p.pl-6.text-xs.text-muted-foreground {{ group.hint }}
        p.py-2.pl-6.text-xs.text-muted-foreground(v-if="!group.files.length") 暂无文件
        ul.flex.flex-col.pl-4(v-else)
          li.flex.min-h-9.items-center.gap-1.rounded-md(v-for="file in group.files" :key="file.path" class="hover:bg-muted/60")
            button.flex.min-w-0.flex-1.items-center.gap-2.py-1.text-left(type="button" :title="file.path" @click="attachmentPreview = file")
              FileIcon(class="size-4 shrink-0 text-muted-foreground")
              span.min-w-0.flex-1.truncate.font-mono.text-sm {{ filename(file.path) }}
              span.shrink-0.text-xs.text-muted-foreground {{ formatFileSize(file.size) }}
            Button(as="a" variant="ghost" size="icon-xs" class="size-8 shrink-0" :href="api.attachmentUrl(file.attachmentId)" :download="filename(file.path)" :aria-label="`下载 ${filename(file.path)}`" title="下载")
              DownloadIcon(data-icon="inline-start")
    section.flex.flex-col.gap-1(v-for="group in sections" :key="group.key")
      .flex.items-start.justify-between.gap-2
        div
          h3(class="text-sm font-medium") {{ group.title }}
          p(class="text-muted-foreground text-xs") {{ group.hint }}
        //- One archive keeps the relative layout: a page the model split across files stays usable.
        Button(
          v-if="group.files.length && group.archive" as="a" variant="ghost" size="xs"
          class="min-h-10 shrink-0 md:min-h-7" :href="group.archive" title="打包下载这一组的全部文件")
          FileArchiveIcon(data-icon="inline-start")
          | 打包下载

      Empty(v-if="!group.files.length" class="border-border rounded-lg border border-dashed py-6")
        EmptyHeader
          EmptyTitle(class="text-sm") 暂无文件
          EmptyDescription(class="text-xs") {{ group.empty }}

      ul.mt-1.flex.flex-col(v-else)
        li.flex.min-h-8.items-center.gap-1.rounded-md.pr-1(
          v-for="row in group.rows" :key="row.key" class="hover:bg-muted/60"
          :style="{ paddingLeft: `${row.depth * 14}px` }")

          template(v-if="row.kind === 'dir'")
            button.flex.min-w-0.flex-1.items-center.gap-1.py-1.text-left(
              type="button" :aria-expanded="isOpen(group.key, row.path)"
              @click="toggleFolder(group.key, row.path)")
              ChevronDownIcon(v-if="isOpen(group.key, row.path)" class="size-3.5 shrink-0 text-muted-foreground")
              ChevronRightIcon(v-else class="size-3.5 shrink-0 text-muted-foreground")
              span(class="min-w-0 truncate font-mono text-sm") {{ row.name }}
              span(class="text-muted-foreground shrink-0 text-xs") {{ row.count }}
            Button(
              v-if="group.archive" as="a" variant="ghost" size="icon-xs" class="size-8 shrink-0"
              :href="folderArchive(group.archive, row.path)"
              :aria-label="`打包下载 ${row.name}`" title="打包下载这个文件夹")
              FileArchiveIcon(data-icon="inline-start")

          template(v-else)
            button.flex.min-w-0.flex-1.items-center.gap-2.py-1.text-left(
              type="button" :title="row.record.path" @click="previewId = row.record.id")
              //- The icon is markstream's own language icon set, matching the chat's code blocks.
              span.shrink-0(class="[&>svg]:size-4" v-html="fileIcon(row.record.relativePath)")
              span(class="min-w-0 truncate font-mono text-sm") {{ row.name }}
              span(class="text-muted-foreground hidden shrink-0 text-xs sm:inline") {{ fileRowMeta(row.record) }}
            Button(
              as="a" variant="ghost" size="icon-xs" class="size-8 shrink-0"
              :href="api.workspaceFileDownloadUrl(row.record.id)"
              :aria-label="`下载 ${row.record.relativePath}`" title="下载")
              DownloadIcon(data-icon="inline-start")
            AlertDialog
              AlertDialogTrigger(as-child)
                Button(
                  type="button" variant="ghost" size="icon-xs" class="size-8 shrink-0"
                  :disabled="busyId === row.record.id" :aria-label="`删除 ${row.record.relativePath}`" title="删除")
                  Trash2Icon(data-icon="inline-start")
              AlertDialogContent
                AlertDialogHeader
                  AlertDialogTitle 删除 {{ row.record.relativePath }}？
                  AlertDialogDescription 模型将不再看到这个文件，已保存的历史版本不会被清除。
                AlertDialogFooter
                  AlertDialogCancel 取消
                  AlertDialogAction(@click="remove(row.record)") 删除

ResponsiveOverlay(:open="attachmentPreview !== null" :title="attachmentPreview?.path ?? '附件'" mode="dialog" @update:open="!$event && (attachmentPreview = null)")
  template(v-if="attachmentPreview")
    img.mx-auto.max-h-full.max-w-full.rounded-md(v-if="attachmentPreview.mime.startsWith('image/')" :src="api.attachmentUrl(attachmentPreview.attachmentId)" :alt="attachmentPreview.path")
    FileAttachment(v-else :attachment-id="attachmentPreview.attachmentId" :mime="attachmentPreview.mime" :filename="filename(attachmentPreview.path)")
  template(#footer)
    .flex.justify-end(v-if="attachmentPreview")
      Button(as="a" variant="outline" :href="api.attachmentUrl(attachmentPreview.attachmentId)" target="_blank" rel="noopener noreferrer") 新标签页打开

WorkspaceFilePreview(:file-id="previewId" @update:file-id="previewId = $event")
</template>
