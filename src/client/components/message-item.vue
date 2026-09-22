<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NodeRendererProps } from 'markstream-vue'
import { CopyIcon, EllipsisIcon, GitForkIcon, LoaderCircle, PencilIcon, RefreshCwIcon, TriangleAlertIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import BranchSwitcher from '@/client/components/branch-switcher.vue'
import MessageFooters from '@/client/components/message-footers.vue'
import LabAvatar from '@/client/components/lab-avatar.vue'
import MessageUsage from '@/client/components/message-usage.vue'
import TurnProcess from '@/client/components/turn-process.vue'
import TurnSegments from '@/client/components/turn-segments.vue'
import { messageSegments, turnBlocks } from '@/client/components/message-segments'
import { canContinueToolMessage } from '@/client/components/tool-part-renderer'
import ProjectAvatar from '@/client/components/project-avatar.vue'
import { useAttachmentUrl, useAuditContext } from '@/client/lib/audit-context'
import { cn } from '@/client/lib/utils'
import { assistantWaitState, editCommandFor, regenerateCommandFor, useSyncStore, type EffectiveModel } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Bubble, BubbleContent } from '@/client/ui/bubble'
import { Button } from '@/client/ui/button'
import { Message as MessageRoot, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '@/client/ui/message'
import { Textarea } from '@/client/ui/textarea'
import type { Message, Project } from '@/shared/models'
import { useConversationFork } from '@/client/composables/use-conversation-fork'
import { useTheme } from '@/client/composables/use-theme'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/client/ui/dropdown-menu'

const props = defineProps<{
  message: Message
  project?: Project
  assistantName?: string
  assistantModelName?: string
  assistantProviderName?: string
  assistantLabId?: string | null
  assistantModelFamily?: string
  optimistic?: boolean
  /** The model the chat would generate with right now; a fresh pick has to reach the hub. */
  effectiveModel?: EffectiveModel
}>()
const sync = useSyncStore()
/** An audited transcript belongs to someone else: nothing here may offer to change it. */
const readonly = useAuditContext() !== null
const attachmentUrl = useAttachmentUrl()
const { resolved: resolvedTheme } = useTheme()
const codeBlockProps: NonNullable<NodeRendererProps['codeBlockProps']> = {
  theme: { light: 'one-light', dark: 'one-dark-pro' },
}
const streaming = computed(() => props.message.status === 'streaming')
const editing = ref(false)
const draft = ref('')

const textParts = computed(() => props.message.parts.filter((p) => p.type === 'text'))
const images = computed(() => props.message.parts.filter((p) => p.type === 'image'))
/**
 * The assistant bubble renders these in order. A reasoning block is "active" — expanded, labelled
 * 正在思考… — only while it is the live tail of a streaming reply; anything arriving after it
 * collapses it, which is what makes a multi-step turn read as a sequence rather than a pile.
 */
const segments = computed(() => messageSegments(props.message.parts))
const activeSegmentKey = computed(() => (streaming.value ? segments.value.at(-1)?.key ?? null : null))
/** Steps fold into collapsibles; speech and output never do. */
const blocks = computed(() => turnBlocks(segments.value))
const copyText = computed(() => {
  if (props.message.role === 'user') return textParts.value.map(part => part.text).join('\n')
  // Progress before the final thinking/tool step is not part of the final answer.
  let lastStep = segments.value.length - 1
  while (lastStep >= 0) {
    const segment = segments.value[lastStep]!
    if (segment.kind === 'reasoning' || segment.kind === 'tool') break
    lastStep--
  }
  return segments.value.slice(lastStep + 1)
    .flatMap(segment => segment.kind === 'text' ? [segment.markdown] : []).join('\n')
})

async function copyMessage() {
  try {
    await navigator.clipboard.writeText(copyText.value)
    toast.success('已复制')
  } catch {
    toast.error('复制失败，请重试')
  }
}

/**
 * A settled assistant turn that produced nothing at all.
 *
 * Ending a turn on a tool call is normal, but the hub always asks the model again once the tool
 * answers, and that turn can come back empty — a macro that ends on a call always does, and any
 * provider is free to. Drawn anyway it was an avatar and a name hanging beside nothing. A failure
 * or a stop still has something to say, so only silence is hidden.
 */
const emptyTurn = computed(() => props.message.role === 'assistant'
  && !streaming.value
  && segments.value.length === 0
  && props.message.status === 'done')
const canContinueTools = computed(() => !readonly && canContinueToolMessage(
  props.message,
  [...(sync.messages.get(props.message.conversation_id)?.values() ?? [])],
  sync.conversations.get(props.message.conversation_id)?.head_message_id,
))
const isConversationHead = computed(() => !readonly && sync.conversations.get(props.message.conversation_id)?.head_message_id === props.message.id)
/** Spec §7.4: the shell is visible the moment it arrives, and never claims reasoning it lacks. */
const wait = computed(() => assistantWaitState(props.message))
const { pending: forkPending, fork } = useConversationFork()

function startEdit() {
  draft.value = textParts.value.map((p) => p.text).join('\n')
  editing.value = true
}
const NO_MODEL: EffectiveModel = { model: null, source: null }
function submitEdit() {
  const parts = [...images.value, { type: 'text' as const, text: draft.value }]
  sync.send(editCommandFor(props.message.id, parts, props.effectiveModel ?? NO_MODEL))
  editing.value = false
}
function regenerate() {
  sync.send(regenerateCommandFor(props.message.id, props.effectiveModel ?? NO_MODEL))
}
</script>

<template lang="pug">
MessageRoot(
  v-if="!emptyTurn"
  :align="message.role === 'user' ? 'end' : 'start'"
  :data-optimistic="optimistic || undefined" :class="cn(optimistic && 'opacity-70')")
  MessageAvatar(v-if="message.role === 'assistant'" class="self-start group-has-data-[slot=message-footer]/message:translate-y-0")
    ProjectAvatar(v-if="project" :project="project")
    LabAvatar(v-else :model-id="message.model_id" :lab-id="assistantLabId ?? null" :family="assistantModelFamily" :provider-name="assistantProviderName ?? assistantName ?? '助手'")

  MessageContent
    MessageHeader(v-if="message.role === 'assistant'" class="gap-2")
      span.truncate.text-foreground {{ assistantName ?? '助手' }}
      Badge(v-if="assistantModelName" variant="outline") {{ assistantModelName }}

    Bubble(:align="message.role === 'user' ? 'end' : 'start'" :variant="message.role === 'user' ? 'tinted' : 'ghost'" :class="cn(message.role === 'assistant' && 'w-full')")
      BubbleContent(:class="cn(message.role === 'assistant' && 'w-full')")
        template(v-if="message.role === 'user'")
          .flex.flex-wrap.gap-2.pb-1(v-if="images.length")
            img.max-h-40.rounded(v-for="img in images" :key="img.attachment_id" :src="attachmentUrl(img.attachment_id)")
          template(v-if="!editing")
            p.whitespace-pre-wrap.text-sm(v-for="(p, i) in textParts" :key="i") {{ p.text }}
          .flex.flex-col.gap-2(v-else)
            Textarea(v-model="draft" class="min-w-64")
            .flex.justify-end.gap-2
              Button(size="sm" class="min-h-10 md:min-h-7" variant="secondary" @click="editing = false") 取消
              Button(size="sm" class="min-h-10 md:min-h-7" @click="submitEdit") 发送
        template(v-else)
          .flex.flex-col.gap-3
            template(v-for="block in blocks" :key="block.key")
              TurnProcess(
                v-if="block.kind === 'process'" :segments="block.segments" :message-id="message.id"
                :streaming="streaming" :active-segment-key="activeSegmentKey"
                :can-continue-tools="canContinueTools" :is-conversation-head="isConversationHead"
                :is-dark="resolvedTheme === 'dark'" :code-block-props="codeBlockProps")
              TurnSegments(
                v-else :segments="[block.segment]" :message-id="message.id"
                :streaming="streaming" :active-segment-key="activeSegmentKey"
                :can-continue-tools="canContinueTools" :is-conversation-head="isConversationHead"
                :is-dark="resolvedTheme === 'dark'" :code-block-props="codeBlockProps")
          MessageFooters(v-if="!streaming" :message="message")
          p.mt-2.flex.items-center.gap-2.text-xs.text-muted-foreground(v-if="wait.waiting && !segments.length")
            LoaderCircle(class="size-3.5 animate-spin")
            span 正在思考…
          Alert(v-if="message.status === 'error'" variant="destructive")
            TriangleAlertIcon
            AlertTitle 生成失败
            AlertDescription {{ message.error ?? '未知错误' }}
          p.text-xs.text-muted-foreground(v-else-if="message.status === 'aborted'") 已停止

    MessageFooter(v-if="!optimistic" class="gap-1")
      Button(
        v-if="!streaming && copyText.trim()" variant="ghost" size="icon-xs"
        class="min-h-10 min-w-10 md:min-h-6 md:min-w-6"
        title="复制消息" aria-label="复制消息" @click="copyMessage")
        CopyIcon(:stroke-width="1.5" class="opacity-80")
      BranchSwitcher(v-if="!readonly" :message="message")
      Button(
        v-if="!readonly && message.role === 'assistant' && !streaming" variant="ghost" size="icon-xs"
        class="min-h-10 min-w-10 md:min-h-6 md:min-w-6"
        title="重新生成" aria-label="重新生成" @click="regenerate")
        RefreshCwIcon
      Button(
        v-if="!readonly && message.role === 'user' && !editing" variant="ghost" size="icon-xs"
        class="min-h-10 min-w-10 md:min-h-6 md:min-w-6"
        title="编辑消息" aria-label="编辑消息" @click="startEdit")
        PencilIcon
      DropdownMenu(v-if="!readonly && message.role === 'assistant' && !streaming")
        DropdownMenuTrigger(as-child)
          Button(
            variant="ghost" size="icon-xs" class="min-h-10 min-w-10 md:min-h-6 md:min-w-6"
            title="更多操作" aria-label="更多消息操作")
            EllipsisIcon
        DropdownMenuContent(align="start")
          DropdownMenuItem(class="min-h-10" :disabled="!!forkPending" @select="fork(message.conversation_id, message.id)")
            GitForkIcon
            span 从此处分叉
      MessageUsage(v-if="message.usage" :usage="message.usage")
</template>
