<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { CircleAlertIcon, LoaderCircle, SquareIcon, WrenchIcon } from '@lucide/vue'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import { cn } from '@/client/lib/utils'
import type { MapNodeData } from '@/client/components/conversation-map'
import { NODE_HEIGHT, NODE_WIDTH } from '@/client/components/conversation-map'

const props = defineProps<{ data: MapNodeData, conversationId: number }>()
const sync = useSyncStore()
const config = useConfigStore()

/**
 * Read from the store by id rather than from `data`. A streaming reply mutates its message on every
 * token; resolving it here repaints this one card and never touches the graph layout.
 */
const message = computed(() => sync.messages.get(props.conversationId)?.get(props.data.messageId))
const isUser = computed(() => message.value?.role === 'user')
const status = computed(() => message.value?.status ?? 'done')
const STATUS_LABELS: Record<string, string> = { streaming: '生成中', error: '失败', aborted: '已停止' }
const statusLabel = computed(() => STATUS_LABELS[status.value] ?? '完成')

const cardClass = computed(() => cn(
  'flex flex-col gap-1 overflow-hidden rounded-lg border px-3 py-2 text-left',
  isUser.value ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-sky-500/60 bg-sky-500/10',
  props.data.active ? 'opacity-100 ring-1' : 'opacity-45',
  props.data.active && (isUser.value ? 'ring-emerald-400' : 'ring-sky-400'),
))
const cardStyle = computed(() => ({ width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }))

const modelLabel = computed(() => {
  const current = message.value
  if (!current || current.provider_id === null || current.model_id === null) return ''
  return config.modelFor({ provider_id: current.provider_id, model_id: current.model_id })?.model.metadata.name
    ?? current.model_id
})

/** Tool-only replies carry no text; naming the tool beats showing an empty card. */
const preview = computed(() => {
  const current = message.value
  if (!current) return ''
  const text = current.parts.filter(part => part.type === 'text').map(part => part.text).join('').trim()
  if (text) return text
  const call = current.parts.find(part => part.type === 'tool_call')
  return call ? call.name : ''
})
const toolOnly = computed(() => preview.value !== '' && message.value?.parts.every(part => part.type !== 'text') === true)

const time = computed(() => {
  const created = message.value?.created_at
  if (!created) return ''
  const at = new Date(created)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
})
</script>

<template lang="pug">
div(:class="cardClass" :style="cardStyle" role="button" :aria-label="`分支节点 ${data.messageId}`")
  Handle(type="target" :position="Position.Top" class="opacity-0")
  .flex.items-center.gap-1.leading-none(class="text-[10px]")
    span.font-medium(:class="isUser ? 'text-emerald-300' : 'text-sky-300'") {{ isUser ? '用户' : '助手' }}
    span.truncate.text-muted-foreground(v-if="modelLabel") {{ modelLabel }}
  .min-h-0.flex-1.overflow-hidden
    p.line-clamp-2.leading-snug.text-foreground(class="text-[11px]")
      WrenchIcon(v-if="toolOnly" class="mr-1 inline size-3 align-[-2px]")
      | {{ preview || '（空）' }}
  .flex.items-center.gap-1.leading-none.text-muted-foreground(class="text-[10px]")
    LoaderCircle(v-if="status === 'streaming'" class="size-3 animate-spin text-sky-400")
    CircleAlertIcon(v-else-if="status === 'error'" class="size-3 text-destructive")
    SquareIcon(v-else-if="status === 'aborted'" class="size-3")
    span(v-else class="size-1.5 rounded-full bg-muted-foreground")
    span {{ statusLabel }}
    span.ml-auto(v-if="time") {{ time }}
  Handle(type="source" :position="Position.Bottom" class="opacity-0")
</template>
