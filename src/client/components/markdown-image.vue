<script setup lang="ts">
import { ref, watch } from 'vue'
import { ImageNode } from 'markstream-vue'
import { ImageOffIcon } from '@lucide/vue'
import AttachmentLightbox from '@/client/components/attachment-lightbox.vue'
import { assetRefOf, resolveAssetRef, useAssetScope } from '@/client/lib/asset-refs'
import { useAttachmentUrl } from '@/client/lib/audit-context'

/**
 * Markdown images in chat. A model names conversation files as `asset:<sha256 prefix>`, which no
 * browser can load; those resolve to the attachment they name in this conversation. Every other
 * URL renders as markstream would.
 */
const props = defineProps<{
  node: { type: 'image', src: string, alt: string, title: string | null, raw: string, loading?: boolean }
  fallbackSrc?: string
  lazy?: boolean
  usePlaceholder?: boolean
}>()
const attachmentUrl = useAttachmentUrl()
const conversationId = useAssetScope()
const url = ref<string | null>(null)
const missing = ref(false)
const lightboxIndex = ref<number | null>(null)

watch(() => props.node.src, async (src) => {
  const assetRef = assetRefOf(src)
  url.value = null
  missing.value = false
  if (assetRef === null || conversationId === null) return
  try {
    const asset = await resolveAssetRef(conversationId, assetRef)
    if (props.node.src !== src) return
    if (asset && asset.mime.startsWith('image/')) url.value = attachmentUrl(asset.attachmentId)
    else missing.value = true
  } catch {
    if (props.node.src === src) missing.value = true
  }
}, { immediate: true })
</script>

<template lang="pug">
ImageNode(v-if="!assetRefOf(node.src)" v-bind="props")
button.my-1.block.w-fit.cursor-zoom-in.rounded(v-else-if="url" type="button" :aria-label="node.alt || '查看图片'" @click="lightboxIndex = 0")
  img(class="max-h-80 rounded border" :src="url" :alt="node.alt" :title="node.title ?? undefined" loading="lazy")
span.inline-flex.items-center.gap-1.rounded.border.px-2.py-1.text-xs.text-muted-foreground(v-else-if="missing")
  ImageOffIcon(class="size-3.5")
  | 找不到图片 {{ node.src }}
span.inline-block.rounded.border.bg-muted(v-else class="h-40 w-32 animate-pulse")
AttachmentLightbox(v-if="url" :images="[{ url }]" :index="lightboxIndex" @update:index="lightboxIndex = $event")
</template>
