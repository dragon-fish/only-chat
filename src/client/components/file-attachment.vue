<script setup lang="ts">
import { ref } from 'vue'
import { useAttachmentUrl } from '@/client/lib/audit-context'
const props = defineProps<{ attachmentId: number; mime: string; filename?: string }>()
const attachmentUrl = useAttachmentUrl()
const failed = ref(false)
</script>

<template>
  <div class="flex max-w-full flex-col gap-2 rounded-md border p-3">
    <audio v-if="mime.startsWith('audio/') && !failed" :src="attachmentUrl(props.attachmentId)" controls preload="metadata" class="max-w-full" @error="failed = true" />
    <video v-else-if="mime.startsWith('video/') && !failed" :src="attachmentUrl(props.attachmentId)" controls preload="metadata" class="max-h-80 max-w-full rounded" @error="failed = true" />
    <p v-if="failed" class="text-sm text-muted-foreground">浏览器无法播放此文件，可以下载查看。</p>
    <a :href="attachmentUrl(props.attachmentId)" :download="filename || 'attachment'" class="text-sm underline">{{ filename || mime }} · 下载</a>
  </div>
</template>
