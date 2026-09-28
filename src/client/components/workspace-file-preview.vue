<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { DownloadIcon, ExternalLinkIcon } from '@lucide/vue'
import MarkdownRender from 'markstream-vue'
import type { NodeRendererProps } from 'markstream-vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Skeleton } from '@/client/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/client/ui/tabs'
import { api } from '@/client/lib/api'
import { useTheme } from '@/client/composables/use-theme'
import { formatFileSize, languageOf, mediaKind, previewKind, type FileRecord, type MediaKind, type PreviewTarget } from './workspace-files'

/** One preview for everything the file panel lists: workspace files, text or binary, and assets. */
const props = defineProps<{ target: PreviewTarget | null }>()
const emit = defineEmits<{ 'update:target': [value: PreviewTarget | null] }>()

const { resolved: resolvedTheme } = useTheme()
const record = ref<FileRecord | null>(null)
const content = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const view = ref<'source' | 'rendered'>('source')
/**
 * A file with bytes rather than lines — any asset, or a binary workspace file — shown from its
 * attachment: that route serves it with its own type and answers `Range`, which seeking needs.
 */
const media = ref<{ kind: MediaKind, url: string, mime: string } | null>(null)
const mediaFailed = ref(false)
const title = computed(() => props.target?.kind === 'asset' ? props.target.name : record.value?.relativePath ?? '文件')
const downloadHref = computed(() => {
  if (props.target?.kind === 'asset') return api.attachmentUrl(props.target.attachmentId)
  return record.value ? api.workspaceFileDownloadUrl(record.value.id) : null
})

/**
 * Rendering model-written HTML is the plugin's own opt-in, and it starts off: the server hands back
 * a preview URL only while that setting is on, so its absence IS the answer. Markdown has no such
 * gate — nothing in it runs.
 */
const frameSrc = ref<string | null>(null)
const canRenderPage = ref(false)
const kind = computed<'markdown' | 'page' | null>(() => {
  const value = record.value === null ? null : previewKind(record.value.relativePath)
  return value === 'page' && !(canRenderPage.value && frameSrc.value !== null) ? null : value
})
const codeBlockProps: NonNullable<NodeRendererProps['codeBlockProps']> = {
  theme: { light: 'one-light', dark: 'one-dark-pro' },
}
/**
 * The source goes through the chat's own markdown renderer as one fenced block, which is what
 * gives it the same highlighting: a hand-assembled code block renders unstyled.
 */
const markdown = computed(() => {
  const language = record.value === null ? 'text' : languageOf(record.value.relativePath)
  // A file carrying a fence of its own must not be able to end the block early.
  const longest = Math.max(0, ...[...content.value.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return fence + language + '\n' + content.value + '\n' + fence
})

watch(() => props.target, async (target) => {
  record.value = null
  content.value = ''
  frameSrc.value = null
  canRenderPage.value = false
  media.value = null
  mediaFailed.value = false
  error.value = null
  loading.value = false
  view.value = 'source'
  if (target === null) return
  if (target.kind === 'asset') {
    media.value = { kind: mediaKind(target.mime), url: api.attachmentUrl(target.attachmentId), mime: target.mime }
    return
  }
  loading.value = true
  try {
    const body = await api.workspaceFile(target.id)
    // A second click while the first was in flight wins; this answer is already stale.
    if (props.target !== target) return
    record.value = body.record
    const kind = mediaKind(body.record.mime)
    if (kind !== 'text') {
      media.value = { kind, url: api.attachmentUrl(body.attachmentId), mime: body.record.mime }
      return
    }
    content.value = body.content ?? ''
    frameSrc.value = body.previewUrl
    canRenderPage.value = body.canRenderPage
    // Markdown is written to be read, so it opens read. Source is one click away either way.
    if (previewKind(body.record.relativePath) === 'markdown') view.value = 'rendered'
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取文件'
  }
  finally {
    loading.value = false
  }
}, { immediate: true })

function setOpen(open: boolean) {
  if (!open) emit('update:target', null)
}
function selectView(value: unknown) {
  if (value === 'source' || value === 'rendered') view.value = value
}
</script>

<template lang="pug">
ResponsiveOverlay(
  mode="dialog" :open="target !== null" :title="title" @update:open="setOpen")
  Alert(v-if="error" variant="destructive")
    AlertTitle 无法读取文件
    AlertDescription {{ error }}
  .flex.flex-col.gap-3(v-else-if="media")
    p(class="text-muted-foreground text-xs")
      template(v-if="record") 第 {{ record.version }} 版 · {{ formatFileSize(record.fileSize) }} · 更新于 {{ new Date(record.updatedAt).toLocaleString() }}
      template(v-else) {{ media.mime }}
    img.mx-auto.max-w-full.rounded-md(v-if="media.kind === 'image'" :src="media.url" :alt="title" class="max-h-[70dvh]")
    //- The browser's own PDF viewer; the attachment route serves it inline with its real type.
    iframe.w-full.rounded-lg.border(v-else-if="media.kind === 'pdf'" :src="media.url" :title="title" class="h-[70dvh]")
    template(v-else-if="(media.kind === 'audio' || media.kind === 'video') && !mediaFailed")
      audio.w-full(v-if="media.kind === 'audio'" :src="media.url" controls preload="metadata" @error="mediaFailed = true")
      video.mx-auto.max-w-full.rounded-md(v-else :src="media.url" controls preload="metadata" class="max-h-[70dvh]" @error="mediaFailed = true")
    p.text-sm.text-muted-foreground(v-else-if="mediaFailed") 浏览器无法播放此文件，可以下载查看。
    p.text-sm.text-muted-foreground(v-else) 这种文件无法预览，可以下载查看。
  .flex.flex-col.gap-2(v-else-if="loading || !record")
    Skeleton(class="h-4 w-48")
    Skeleton(class="h-40 w-full")
  template(v-else)
    .mb-3.flex.flex-wrap.items-center.justify-between.gap-2
      p(class="text-muted-foreground text-xs")
        | 第 {{ record.version }} 版 · {{ formatFileSize(record.fileSize) }} · {{ record.totalLines }} 行 · 更新于 {{ new Date(record.updatedAt).toLocaleString() }}
      Tabs(v-if="kind" :model-value="view" @update:model-value="selectView")
        TabsList
          TabsTrigger(value="source" class="min-h-10 md:min-h-7") 源码
          TabsTrigger(value="rendered" class="min-h-10 md:min-h-7") 预览
    //- Markdown renders with the chat's own `safe` policy: script tags and event handlers never
    //- survive it, so a file is no more dangerous to read than the reply that wrote it.
    MarkdownRender(
      v-if="kind === 'markdown' && view === 'rendered'" mode="chat" :content="content"
      :final="true" :smooth-streaming="false" :is-dark="resolvedTheme === 'dark'"
      :code-block-props="codeBlockProps")
    //- Sandboxed without `allow-same-origin`: the page gets an opaque origin, so it cannot read
    //- this app's cookies or reach into the parent. It still runs code a model wrote.
    iframe(
      v-else-if="kind === 'page' && view === 'rendered'" class="bg-background h-[60dvh] w-full rounded-lg border"
      :src="frameSrc ?? undefined"
      sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer"
      :title="`${record.relativePath} 预览`")
    //- Source, never executed by the app itself.
    MarkdownRender(
      v-else mode="chat" :content="markdown" :final="true" :smooth-streaming="false"
      :is-dark="resolvedTheme === 'dark'" :code-block-props="codeBlockProps")
  template(#footer)
    .flex.flex-wrap.items-center.justify-end.gap-2
      //- The download route hands every file over as an attachment, so this is the only way to
      //- just look at one; with the page setting off it arrives as text, which shows rather than runs.
      Button(
        v-if="media || frameSrc" as="a" variant="ghost" class="min-h-10"
        :href="media?.url ?? frameSrc ?? undefined" target="_blank" rel="noopener noreferrer")
        ExternalLinkIcon(data-icon="inline-start")
        | 新标签页打开
      //- An asset's route serves it inline, so the attribute is what makes this a download.
      Button(
        v-if="downloadHref" as="a" variant="outline" class="min-h-10" :href="downloadHref"
        :download="target?.kind === 'asset' ? target.name : undefined")
        DownloadIcon(data-icon="inline-start")
        | 下载
</template>
