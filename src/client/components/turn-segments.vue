<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import type { NodeRendererProps } from 'markstream-vue'
import ReasoningBlock from '@/client/components/reasoning-block.vue'
import ToolPartRenderer from '@/client/components/tool-part-renderer.vue'
import type { MessageSegment } from '@/client/components/message-segments'
import { api } from '@/client/lib/api'

/** One definition, used for the collapsed process and for the answer below it. */
defineProps<{
  segments: readonly MessageSegment[]
  messageId: number
  streaming: boolean
  /** The segment currently being written, if any — the only one that animates or ticks. */
  activeSegmentKey: string | null
  canContinueTools: boolean
  isConversationHead: boolean
  isDark: boolean
  codeBlockProps: NonNullable<NodeRendererProps['codeBlockProps']>
}>()
</script>

<template lang="pug">
.flex.flex-col.gap-2
  template(v-for="segment in segments" :key="segment.key")
    ReasoningBlock(
      v-if="segment.kind === 'reasoning'" :text="segment.text"
      :duration-ms="segment.durationMs"
      :active="segment.key === activeSegmentKey")
    MarkdownRender(
      v-else-if="segment.kind === 'text'"
      mode="chat" :content="segment.markdown"
      :final="!streaming || segment.key !== activeSegmentKey" :smooth-streaming="false" :fade="true"
      :is-dark="isDark" :code-block-props="codeBlockProps")
    ToolPartRenderer(
      v-else-if="segment.kind === 'tool'" :message-id="messageId"
      :call="segment.call" :result="segment.result" :can-continue="canContinueTools"
      :defer-pending="isConversationHead"
      :input-pending="streaming && typeof segment.call.args === 'string'")
    //- Generated images are served by the same authenticated attachment route as uploads.
    img(
      v-else-if="segment.kind === 'image'" class="max-h-80 rounded border"
      :src="api.attachmentUrl(segment.part.attachment_id)")
    //- The operator, mid-turn. Aligned right and tinted like their own messages, because that is
    //- whose words these are — the assistant message is only where they had to be stored.
    .flex.w-full.justify-end(v-else-if="segment.kind === 'interjection'")
      .flex.flex-col.gap-2.rounded-xl.px-3.py-2(class="bg-muted max-w-[85%] text-sm")
        template(v-for="(said, i) in segment.part.parts" :key="i")
          img(
            v-if="said.type === 'image'" class="max-h-60 rounded border"
            :src="api.attachmentUrl(said.attachment_id)")
          p.whitespace-pre-wrap(v-else) {{ said.text }}
</template>
