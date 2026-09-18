<script setup lang="ts">
import { computed } from 'vue'
import { useAttachmentUrl } from '@/client/lib/audit-context'
import type { Message } from '@/shared/models'
import { shotsInTurn } from './turn-shots'

const props = defineProps<{ message: Message }>()
const attachmentUrl = useAttachmentUrl()

/**
 * Additive, not a move. Each card keeps the pictures of its own call, because the run is worth
 * reading in the order it happened; this is the same pictures gathered once at the end, where the
 * reader is looking when the turn is over.
 */
const shots = computed(() => shotsInTurn(props.message.parts))
</script>

<template lang="pug">
.flex.flex-col.gap-1(v-if="shots.length")
  p(class="text-muted-foreground text-xs") 本轮的浏览器截图
  .flex.flex-wrap.gap-2
    a(
      v-for="shot in shots" :key="shot.attachmentId" :href="attachmentUrl(shot.attachmentId)"
      target="_blank" rel="noopener" :title="shot.name"
      class="block overflow-hidden rounded-md border")
      img.h-24.w-auto.max-w-48.object-cover(
        :src="attachmentUrl(shot.attachmentId)" :alt="shot.name" loading="lazy")
</template>
