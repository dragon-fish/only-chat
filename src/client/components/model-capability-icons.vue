<script setup lang="ts">
import { computed } from 'vue'
import { BrainIcon, EyeIcon, FileTextIcon, ImagePlusIcon, AudioLinesIcon, VideoIcon, WrenchIcon } from '@lucide/vue'
import { Badge } from '@/client/ui/badge'
import { modelBadges } from '@/client/lib/ui-models'
import type { ModelListItem } from '@/shared/models'
const props = defineProps<{ model: ModelListItem }>()
const capabilities = computed(() => modelBadges(props.model))
const icons = { vision: EyeIcon, pdf: FileTextIcon, audio: AudioLinesIcon, video: VideoIcon, reasoning: BrainIcon, tools: WrenchIcon, image_output: ImagePlusIcon }
</script>

<template>
  <span v-if="capabilities.length" class="flex shrink-0 items-center gap-1">
    <Badge v-for="capability in capabilities" :key="capability.key" variant="secondary" class="px-1 py-0.5" role="img" :aria-label="capability.label" :title="capability.label">
      <component :is="icons[capability.key]" aria-hidden="true" />
    </Badge>
  </span>
</template>
