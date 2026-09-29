<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDownIcon, ChevronRightIcon, DownloadIcon, FileArchiveIcon, RefreshCwIcon, Trash2Icon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Skeleton } from '@/client/ui/skeleton'
import { api, withDownloadName } from '@/client/lib/api'
import { useSyncStore } from '@/client/stores/sync'
import FileThumb from './file-thumb.vue'
import WorkspaceFilePreview from './workspace-file-preview.vue'
import {
  assetName, assetRowMeta, fileRowMeta, fileTreeRows, mediaKind,
  type ConversationAsset, type FileRecord, type FileTreeRow, type PreviewTarget,
} from './workspace-files'

const props = defineProps<{
  /** Which mount to list. A conversation also shows the Project mount it can reach. */
  mount: 'project' | 'conversation'
  scopeId: number
}>()

const files = ref<FileRecord[]>([])
const projectFiles = ref<FileRecord[]>([])
/** Files sent and generated in this conversation. Read-only, and only the conversation mount has them. */
const assets = ref<ConversationAsset[]>([])
const sync = useSyncStore()
/** The Project a conversation can also reach, so its archive can be offered beside its files. */
const projectId = ref<number | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const preview = ref<PreviewTarget | null>(null)
const busyId = ref<number | null>(null)
/** Open folders, keyed by `${section}:${path}` so two mounts cannot open each other's. */
const expanded = ref(new Set<string>())

/**
 * Mount paths are the model's addressing scheme, not a concept to teach a reader. The panel says
 * where a file lives by grouping, and inside a group shows the folder shape the model wrote.
 */
interface FileSection {
  kind: 'files'
  key: string
  title: string
  hint: string
  files: FileRecord[]
  empty: string
  archive: string | null
  rows: FileTreeRow[]
}
interface AssetSection {
  kind: 'assets'
  key: string
  title: string
  hint: string
  assets: ConversationAsset[]
}

const sections = computed((): (FileSection | AssetSection)[] => {
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
  const withRows = (group: Omit<FileSection, 'kind' | 'rows'>): FileSection => ({
    ...group,
    kind: 'files',
    rows: fileTreeRows(group.files, new Set(
      [...expanded.value].filter(key => key.startsWith(`${group.key}:`)).map(key => key.slice(group.key.length + 1)),
    )),
  })
  if (props.mount === 'project') return [withRows(project)]

  // A conversation outside a Project has no Project group, and neither empty extra group earns
  // a heading: the conversation's own group is the one that explains an empty panel.
  const groups: (FileSection | AssetSection)[] = [withRows(conversation)]
  if (assets.value.length > 0) {
    groups.push({ kind: 'assets', key: 'assets', title: '本会话的附件', hint: '你发送的和生成的文件，只读。', assets: assets.value })
  }
  if (projectFiles.value.length > 0) groups.push(withRows(project))
  return groups
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
      projectFiles.value = []
      projectId.value = props.scopeId
    }
    else {
      const [body, assetBody] = await Promise.all([api.conversationFiles(props.scopeId), api.conversationAssets(props.scopeId)])
      if (epoch !== loadEpoch) return
      files.value = body.files
      projectFiles.value = body.projectFiles
      projectId.value = body.projectId
      assets.value = assetBody.assets
    }
  }
  catch (cause) {
    if (epoch === loadEpoch) error.value = cause instanceof Error ? cause.message : '无法加载文件列表'
  }
  finally {
    if (epoch === loadEpoch) loading.value = false
  }
}

/**
 * A turn is what adds files — by upload, by generation, or by a tool — so the list reloads when this
 * conversation starts and stops streaming. Message contents are not watched: every delta would
 * re-run the watcher for an answer that only changes at those two edges.
 */
const streaming = computed(() => props.mount === 'conversation' && sync.isStreaming(props.scopeId))
watch(() => [props.mount, props.scopeId, streaming.value] as const, (next, prev) => {
  if (!prev || next[0] !== prev[0] || next[1] !== prev[1]) {
    files.value = []; projectFiles.value = []; assets.value = []
  }
  void load()
}, { immediate: true })

const hasAnything = computed(() => files.value.length > 0 || assets.value.length > 0)

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

  .flex.flex-col.gap-2(v-else-if="loading && !hasAnything")
    Skeleton(v-for="n in 3" :key="n" class="h-8 w-full")

  template(v-else)
    section.flex.flex-col.gap-1(v-for="group in sections" :key="group.key")
      .flex.items-start.justify-between.gap-2
        div
          h3(class="text-sm font-medium") {{ group.title }}
          p(class="text-muted-foreground text-xs") {{ group.hint }}
        //- One archive keeps the relative layout: a page the model split across files stays usable.
        Button(
          v-if="group.kind === 'files' && group.files.length && group.archive" as="a" variant="ghost" size="xs"
          class="min-h-10 shrink-0 md:min-h-7" :href="group.archive" title="打包下载这一组的全部文件")
          FileArchiveIcon(data-icon="inline-start")
          | 打包下载

      ul.mt-1.flex.flex-col(v-if="group.kind === 'assets'")
        li.flex.min-h-8.items-center.gap-1.rounded-md.pr-1(v-for="asset in group.assets" :key="asset.attachmentId" class="hover:bg-muted/60")
          //- The tooltip is how a person cites the file in chat: it is the model's own name for it.
          button.flex.min-w-0.flex-1.items-center.gap-2.py-1.text-left(
            type="button" :title="assetName(asset)"
            @click="preview = { kind: 'asset', attachmentId: asset.attachmentId, mime: asset.mime, name: assetName(asset) }")
            FileThumb(:mime="asset.mime" :src="api.attachmentUrl(asset.attachmentId)")
            span(class="min-w-0 truncate text-sm") {{ assetName(asset) }}
            span(class="text-muted-foreground hidden shrink-0 text-xs sm:inline") {{ assetRowMeta(asset) }}
          Button(
            as="a" variant="ghost" size="icon-xs" class="size-8 shrink-0"
            :href="withDownloadName(api.attachmentUrl(asset.attachmentId), assetName(asset))" :download="assetName(asset)"
            :aria-label="`下载 ${assetName(asset)}`" title="下载")
            DownloadIcon(data-icon="inline-start")

      Empty(v-else-if="!group.files.length" class="border-border rounded-lg border border-dashed py-6")
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
              type="button" :title="row.record.relativePath" @click="preview = { kind: 'file', id: row.record.id }")
              //- Only a binary file has a picture to show; the download route serves it as its own type.
              FileThumb(
                :mime="row.record.mime" :name="row.record.relativePath"
                :src="mediaKind(row.record.mime) === 'image' ? api.workspaceFileDownloadUrl(row.record.id) : undefined")
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

WorkspaceFilePreview(:target="preview" @update:target="preview = $event")
</template>
