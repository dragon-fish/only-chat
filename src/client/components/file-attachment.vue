<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { DownloadIcon, ExternalLinkIcon, FileAudioIcon, FileIcon, FileTextIcon, FileVideoIcon } from '@lucide/vue'
import { fileIcon, formatFileSize } from '@/client/components/workspace-files'
import { useAttachmentUrl } from '@/client/lib/audit-context'
import { fileModality, isTextMime } from '@/shared/file-media'

const props = defineProps<{ attachmentId: number; mime: string; filename?: string; sourceEncoding?: string }>()
const attachmentUrl = useAttachmentUrl()
const url = computed(() => attachmentUrl(props.attachmentId))
const kind = computed(() => fileModality(props.mime))
const icon = computed(() => ({ pdf: FileTextIcon, audio: FileAudioIcon, video: FileVideoIcon, image: FileIcon })[kind.value ?? 'image'])
const text = computed(() => isTextMime(props.mime))
const label = computed(() => props.filename || props.mime)
const failed = ref(false)
const size = ref<number | null>(null)

/**
 * A file part carries no size, so it is read from the download route: a one-byte range answers
 * with `Content-Range: bytes 0-0/<total>` without transferring the file. A failure only hides the
 * size; the card stays usable.
 */
async function loadSize(target: string) {
  size.value = null
  try {
    const response = await fetch(target, { headers: { range: 'bytes=0-0' } })
    const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1] ?? (response.status === 200 ? response.headers.get('content-length') : null)
    void response.body?.cancel()
    if (target === url.value && total) size.value = Number(total)
  } catch { /* size stays unknown */ }
}
watch(url, target => { failed.value = false; void loadSize(target) }, { immediate: true })
</script>

<template lang="pug">
.flex.max-w-full.min-w-0.flex-col.gap-2.rounded-md.border.p-3
  .flex.min-w-0.items-center.gap-3
    //- Text takes markstream's language icon, matching the chat's code blocks.
    span.shrink-0(v-if="text" class="[&>svg]:size-8" v-html="fileIcon(filename ?? '')")
    component.shrink-0.text-muted-foreground(v-else :is="icon" class="size-8")
    .min-w-0.flex-1
      p.truncate.text-sm.font-medium(:title="label") {{ label }}
      p.text-xs.text-muted-foreground {{ size === null ? mime : formatFileSize(size) }}
      //- Stored as UTF-8: a download is not byte for byte the file that was picked.
      p.text-xs.text-amber-600(v-if="sourceEncoding" class="dark:text-amber-400") 已从 {{ sourceEncoding }} 转换为 UTF-8
    a.inline-flex.shrink-0.items-center.justify-center.rounded-md(
      :href="url" target="_blank" rel="noopener" title="打开" aria-label="打开文件"
      class="size-10 hover:bg-accent md:size-8")
      ExternalLinkIcon(class="size-4")
    a.inline-flex.shrink-0.items-center.justify-center.rounded-md(
      :href="url" :download="filename || 'attachment'" title="下载" aria-label="下载文件"
      class="size-10 hover:bg-accent md:size-8")
      DownloadIcon(class="size-4")
  audio.max-w-full(v-if="kind === 'audio' && !failed" :src="url" controls preload="metadata" @error="failed = true")
  video.max-w-full.rounded(v-else-if="kind === 'video' && !failed" :src="url" controls preload="metadata" class="max-h-80" @error="failed = true")
  p.text-sm.text-muted-foreground(v-if="failed") 浏览器无法播放此文件，可以下载查看。
</template>
