<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { useOverlayLeave } from '@/client/composables/use-route-overlay'
import MessageList from '@/client/components/message-list.vue'
import { api } from '@/client/lib/api'
import { createAuditContext, provideAuditContext } from '@/client/lib/audit-context'
import type { ConversationParams } from '@/shared/models'
import { pathToRoot } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Spinner } from '@/client/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/client/ui/tabs'
import type { AuditProviderRow, AuditTranscript } from '@/shared/api'

/** The listing keys this on the id: the context below is bound to one conversation's owner. */
const props = defineProps<{ conversationId: number }>()
/** `leave` fires once the exit animation is over; the listing then drops `?preview` from the URL. */
const emit = defineEmits<{ leave: [] }>()
const { open, setOpen } = useOverlayLeave(() => emit('leave'))
const providers = shallowRef<AuditProviderRow[]>([])
const transcript = shallowRef<AuditTranscript | null>(null)
const loading = ref(true)
const error = ref('')
const audit = createAuditContext(() => providers.value)
provideAuditContext(audit)

const config = computed(() => transcript.value?.config ?? null)
const configModel = computed(() => {
  const model = config.value?.model
  if (!model) return null
  const found = audit.resolveModel(model)
  return found ? `${found.name ?? model.model_id}（${found.providerName}）` : model.model_id
})
/** Only what a layer actually set; everything else is the model's own default. */
const paramRows = computed(() => {
  const params: ConversationParams = config.value?.params ?? {}
  const rows: { label: string, value: string }[] = []
  if (params.temperature !== undefined) rows.push({ label: 'temperature', value: String(params.temperature) })
  if (params.top_p !== undefined) rows.push({ label: 'top_p', value: String(params.top_p) })
  if (params.max_tokens !== undefined) rows.push({ label: '最大输出 token', value: String(params.max_tokens) })
  if (params.reasoning_enabled !== undefined) rows.push({ label: '推理', value: params.reasoning_enabled ? '开启' : '关闭' })
  if (params.reasoning_effort !== undefined) rows.push({ label: '推理强度', value: params.reasoning_effort ?? '自动' })
  return rows
})

/** The branch the audited user is looking at: the one ending at the conversation's head. */
const path = computed(() => transcript.value
  ? pathToRoot(new Map(transcript.value.messages.map(message => [message.id, message])), transcript.value.conversation.head_message_id)
  : [])

onMounted(async () => {
  try {
    const loaded = await api.auditTranscript(props.conversationId)
    // Model names resolve against the owner's providers; without them the raw model id still shows.
    providers.value = (await api.auditProviders({ user: String(loaded.owner.id), limit: '500' }).catch(() => null))?.rows ?? []
    transcript.value = loaded
  } catch { error.value = '无法加载该会话。审计可能未开启，或会话不存在。' }
  finally { loading.value = false }
})
</script>

<template lang="pug">
ResponsiveOverlay(
  mode="dialog" :open="open" :title="transcript?.conversation.title || '会话预览'"
  @update:open="setOpen")
  template(#status)
    Badge(v-if="transcript" variant="outline") 只读 · {{ transcript.owner.name }}
  .flex.justify-center.py-8(v-if="loading")
    Spinner(aria-label="正在加载会话")
  Alert(v-else-if="error" variant="destructive")
    AlertTitle 加载失败
    AlertDescription {{ error }}
  Tabs(v-else default-value="messages" class="gap-4")
    TabsList
      TabsTrigger(value="messages") 对话
      TabsTrigger(value="config") 生效配置
    TabsContent(value="messages")
      //- MessageList scrolls itself, so it needs a bounded height inside the overlay's own scroller.
      div(v-if="path.length" class="-mx-4 h-[calc(100dvh-10rem)] md:h-[65dvh]")
        MessageList(:messages="path")
      Empty(v-else)
        EmptyHeader
          EmptyTitle 没有消息
          EmptyDescription 这个会话还没有任何消息。
    TabsContent(value="config" data-audit-config)
      p.mb-4.text-xs.text-muted-foreground 按当前 Project 与会话设置计算，是下一轮会使用的配置；单轮临时选择的模型与推理强度不会被保存。
      dl.grid.gap-x-4.gap-y-3.text-sm(v-if="config" class="grid-cols-[auto_1fr]")
        dt.text-muted-foreground Project
        dd {{ config.project?.name ?? '无' }}
        dt.text-muted-foreground 模型
        dd {{ configModel ?? '未设置（发送时选择）' }}
        dt.text-muted-foreground 参数
        dd
          span.text-muted-foreground(v-if="!paramRows.length") 未设置，使用模型默认值
          .grid.gap-x-3.gap-y-1(v-else class="grid-cols-[auto_1fr]")
            template(v-for="param in paramRows" :key="param.label")
              span.text-muted-foreground {{ param.label }}
              code.text-xs {{ param.value }}
        dt.text-muted-foreground 系统提示词
        dd.min-w-0
          span.text-muted-foreground(v-if="config.systemPrompt === null") 无
          pre.max-h-96.overflow-auto.whitespace-pre-wrap.break-words.rounded-md.bg-muted.p-3.text-xs(v-else) {{ config.systemPrompt }}
</template>
