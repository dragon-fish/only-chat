<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownRender from 'markstream-vue'
import type { NodeRendererProps } from 'markstream-vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Skeleton } from '@/client/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/client/ui/tabs'
import { api } from '@/client/lib/api'
import { useTheme } from '@/client/composables/use-theme'
import { formatFileSize, isRenderable, languageOf, type FileRecord } from './workspace-files'

const props = defineProps<{ fileId: number | null }>()
const emit = defineEmits<{ 'update:fileId': [value: number | null] }>()

const { resolved: resolvedTheme } = useTheme()
const record = ref<FileRecord | null>(null)
const content = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const view = ref<'source' | 'rendered'>('source')

/**
 * Rendering model-written HTML is the plugin's own opt-in, and it starts off: the server hands back
 * a preview URL only while that setting is on, so its absence IS the answer.
 */
const frameSrc = ref<string | null>(null)
const canRender = computed(() => (
  frameSrc.value !== null && record.value !== null && isRenderable(record.value.relativePath)
))
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

watch(() => props.fileId, async (fileId) => {
  record.value = null
  content.value = ''
  frameSrc.value = null
  error.value = null
  view.value = 'source'
  if (fileId === null) return
  loading.value = true
  try {
    const body = await api.workspaceFile(fileId)
    // A second click while the first was in flight wins; this answer is already stale.
    if (props.fileId !== fileId) return
    record.value = body.record
    content.value = body.content
    frameSrc.value = body.previewUrl
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
function selectView(value: unknown) {
  if (value === 'source' || value === 'rendered') view.value = value
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
    .mb-3.flex.flex-wrap.items-center.justify-between.gap-2
      p(class="text-muted-foreground text-xs")
        | 第 {{ record.version }} 版 · {{ formatFileSize(record.fileSize) }} · {{ record.totalLines }} 行 · 更新于 {{ new Date(record.updatedAt).toLocaleString() }}
      Tabs(v-if="canRender" :model-value="view" @update:model-value="selectView")
        TabsList
          TabsTrigger(value="source" class="min-h-10 md:min-h-7") 源码
          TabsTrigger(value="rendered" class="min-h-10 md:min-h-7") 渲染
    //- Sandboxed without `allow-same-origin`: the page gets an opaque origin, so it cannot read
    //- this app's cookies or reach into the parent. It still runs code a model wrote.
    iframe(
      v-if="canRender && view === 'rendered'" class="bg-background h-[60dvh] w-full rounded-lg border"
      :src="frameSrc ?? undefined"
      sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer"
      :title="`${record.relativePath} 预览`")
    //- Source, never executed by the app itself.
    MarkdownRender(
      v-else mode="chat" :content="markdown" :final="true" :smooth-streaming="false"
      :is-dark="resolvedTheme === 'dark'" :code-block-props="codeBlockProps")
  template(#footer)
    Button(v-if="record" as="a" variant="outline" class="min-h-10" :href="api.workspaceFileDownloadUrl(record.id)") 下载
</template>
