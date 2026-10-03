<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeftIcon, RefreshCwIcon, SendIcon, Trash2Icon } from '@lucide/vue'
import MarkdownRender from 'markstream-vue'
import type { NodeRendererProps } from 'markstream-vue'
import { toast } from 'vue-sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { Skeleton } from '@/client/ui/skeleton'
import { Textarea } from '@/client/ui/textarea'
import { api } from '@/client/lib/api'
import { useTheme } from '@/client/composables/use-theme'
import { startConversation } from '@/client/lib/new-conversation-handoff'
import { MEMORY_SAVE_TOOL_ID, type MemoryListItem } from '../shared'

/**
 * One layer of memory: a list grouped by type, a memory's details, and a box that hands an
 * instruction to a new conversation. Nothing here edits a memory — the model does that.
 */
const props = defineProps<{ projectId: number | null }>()
const router = useRouter()
const { resolved: resolvedTheme } = useTheme()
const codeBlockProps: NonNullable<NodeRendererProps['codeBlockProps']> = {
  theme: { light: 'one-light', dark: 'one-dark-pro' },
}

const items = ref<MemoryListItem[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const opened = ref<MemoryListItem | null>(null)
const body = ref<string | null>(null)
const bodyError = ref<string | null>(null)
const deleting = ref(false)
const instruction = ref('')
const starting = ref(false)

const GROUPS = [
  { type: 'user', title: '关于你' },
  { type: 'feedback', title: '做事方式' },
  { type: 'project', title: '项目背景' },
  { type: 'reference', title: '参考' },
  { type: null, title: '未描述' },
] as const

const groups = computed(() => GROUPS
  .map(group => ({ ...group, items: items.value.filter(item => item.type === group.type) }))
  .filter(group => group.items.length > 0))

const relative = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
function updatedLabel(at: number): string {
  const minutes = Math.round((at - Date.now()) / 60_000)
  if (Math.abs(minutes) < 60) return `更新于${relative.format(minutes, 'minute')}`
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return `更新于${relative.format(hours, 'hour')}`
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return `更新于${relative.format(days, 'day')}`
  return `更新于 ${new Date(at).toLocaleDateString()}`
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const result = props.projectId === null ? await api.userMemories() : await api.projectMemories(props.projectId)
    items.value = result.memories
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法加载记忆'
  }
  finally {
    loading.value = false
  }
}
watch(() => props.projectId, () => { opened.value = null; void load() }, { immediate: true })

async function open(item: MemoryListItem) {
  opened.value = item
  body.value = null
  bodyError.value = null
  try {
    const file = await api.workspaceFile(item.fileId)
    if (opened.value?.fileId === item.fileId) body.value = file.content ?? ''
  }
  catch (cause) {
    if (opened.value?.fileId === item.fileId) bodyError.value = cause instanceof Error ? cause.message : '无法读取这条记忆'
  }
}

async function remove(item: MemoryListItem) {
  deleting.value = true
  try {
    await api.deleteWorkspaceFile(item.fileId)
    toast.success(`已删除「${item.name}」`, { description: '它在工作区回收站里保留 30 天。' })
    opened.value = null
    await load()
  }
  catch (cause) {
    toast.error(cause instanceof Error ? cause.message : '无法删除这条记忆')
  }
  finally {
    deleting.value = false
  }
}

/**
 * Sent as typed: the model decides whether anything is worth remembering. Only the details view
 * adds which memory the words are about, which they cannot say on their own.
 */
async function hand() {
  const text = instruction.value.trim()
  if (!text || starting.value) return
  starting.value = true
  try {
    const prompt = opened.value === null ? text : `关于记忆 ${opened.value.path}：${text}`
    await startConversation(router, props.projectId, { prompt, tools: [MEMORY_SAVE_TOOL_ID] })
  }
  finally {
    starting.value = false
  }
}

defineExpose({ load })
</script>

<template lang="pug">
.flex.flex-col.gap-4
  template(v-if="opened")
    .flex.items-center.justify-between.gap-2
      Button(type="button" variant="ghost" size="sm" class="min-h-10 -ml-2" @click="opened = null")
        ArrowLeftIcon(data-icon="inline-start")
        | 返回列表
      AlertDialog
        AlertDialogTrigger(as-child)
          Button(type="button" variant="outline" size="sm" class="min-h-10" :disabled="deleting")
            Trash2Icon(data-icon="inline-start")
            | 删除
        AlertDialogContent
          AlertDialogHeader
            AlertDialogTitle 删除「{{ opened.name }}」？
            AlertDialogDescription 模型将不再记得这件事。文件会进入工作区回收站，30 天内可以还原。
          AlertDialogFooter
            AlertDialogCancel(class="min-h-10") 取消
            AlertDialogAction(class="min-h-10" variant="destructive" @click="remove(opened)") 删除
    .flex.flex-col.gap-1
      h3.text-lg.font-semibold {{ opened.name }}
      p(class="text-muted-foreground text-xs") {{ updatedLabel(opened.updatedAt) }} · {{ opened.path }}
    .flex.flex-col.gap-1
      p(class="text-muted-foreground text-xs") 摘要
      p.text-sm(v-if="opened.description") {{ opened.description }}
      p(v-else class="text-muted-foreground text-sm") 还没有描述，模型下次看到时会补上。
    .flex.flex-col.gap-1
      p(class="text-muted-foreground text-xs") 详情
      Alert(v-if="bodyError" variant="destructive")
        AlertTitle 无法读取
        AlertDescription {{ bodyError }}
      Skeleton(v-else-if="body === null" class="h-24 w-full")
      MarkdownRender(
        v-else mode="chat" :content="body" :final="true" :smooth-streaming="false"
        :is-dark="resolvedTheme === 'dark'" :code-block-props="codeBlockProps")

  template(v-else)
    .flex.items-center.justify-end
      Button(type="button" variant="ghost" size="xs" class="min-h-10 md:min-h-6" :disabled="loading" @click="load")
        RefreshCwIcon(data-icon="inline-start")
        | 刷新
    Alert(v-if="error" variant="destructive")
      AlertTitle 无法加载记忆
      AlertDescription
        p {{ error }}
        Button(variant="outline" class="mt-2 min-h-10" @click="load") 重试
    .flex.flex-col.gap-2(v-else-if="loading && !items.length")
      Skeleton(v-for="n in 3" :key="n" class="h-10 w-full")
    Empty(v-else-if="!items.length" class="border-border rounded-lg border border-dashed py-8")
      EmptyHeader
        EmptyTitle(class="text-sm") 还没有记忆
        EmptyDescription(class="text-xs") 模型在对话中学到值得记住的事时会自动保存，你也可以在下面告诉它。
    section.flex.flex-col.gap-2(v-for="group in groups" v-else :key="group.title")
      h3(class="text-muted-foreground text-xs font-medium") {{ group.title }}
      ItemGroup(class="gap-2")
        Item(v-for="item in group.items" :key="item.fileId" as-child variant="outline" size="sm" class="hover:bg-muted/60")
          button.w-full.text-left(type="button" :title="item.path" @click="open(item)")
            ItemContent(class="min-w-0")
              ItemTitle {{ item.name }}
              ItemDescription.truncate {{ item.description ?? '未描述' }}
            ItemActions(class="text-muted-foreground hidden text-xs md:flex") {{ updatedLabel(item.updatedAt) }}

  form.flex.items-end.gap-2(@submit.prevent="hand")
    Textarea(
      v-model="instruction" class="min-h-10 flex-1" rows="1"
      :placeholder="opened ? '告诉模型这条记忆要怎么改，或者删掉它' : '告诉模型要记住、修改或忘记什么'"
      @keydown.enter.exact.prevent="hand")
    Button(type="submit" size="icon" class="size-10 shrink-0" :disabled="!instruction.trim() || starting" aria-label="在新会话中交给模型处理" title="在新会话中交给模型处理")
      SendIcon
  p(class="text-muted-foreground -mt-2 text-xs") 会新开一个只带记忆工具的会话来处理；不涉及记忆的话，模型不会改动任何记忆。
</template>
