<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import type { NodeRendererProps } from 'markstream-vue'
import { computed, ref } from 'vue'
import ReasoningBlock from '@/client/components/reasoning-block.vue'
import AttachmentLightbox from '@/client/components/attachment-lightbox.vue'
import ToolPartRenderer from '@/client/components/tool-part-renderer.vue'
import type { MessageSegment } from '@/client/components/message-segments'
import { useAttachmentUrl } from '@/client/lib/audit-context'

/** One definition, used for the collapsed process and for the answer below it. */
const props = defineProps<{
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
const attachmentUrl = useAttachmentUrl()

/** The images this turn drew, stepped through together in the lightbox. */
const imageSegments = computed(() => props.segments.flatMap(segment => (segment.kind === 'image' ? [segment] : [])))
const lightboxImages = computed(() => imageSegments.value.map(segment => ({ url: attachmentUrl(segment.part.attachment_id) })))
const lightboxIndex = ref<number | null>(null)
function openImage(key: string) {
  lightboxIndex.value = imageSegments.value.findIndex(segment => segment.key === key)
}
</script>

<template lang="pug">
.flex.flex-col.gap-2
  template(v-for="segment in segments" :key="segment.key")
    ReasoningBlock(
      v-if="segment.kind === 'reasoning'" :text="segment.text"
      :duration-ms="segment.durationMs" :tokens="segment.tokens"
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
      :input-pending="streaming && typeof segment.call.args === 'string'"
      :settled="!streaming")
    //- Generated images are served by the same authenticated attachment route as uploads.
    button.w-fit.cursor-zoom-in.rounded(
      v-else-if="segment.kind === 'image'" type="button" aria-label="查看图片" @click="openImage(segment.key)")
      img(class="max-h-80 rounded border" :src="attachmentUrl(segment.part.attachment_id)" alt="")
  AttachmentLightbox(:images="lightboxImages" :index="lightboxIndex" @update:index="lightboxIndex = $event")
</template>
