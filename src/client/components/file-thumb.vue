<script setup lang="ts">
import { computed } from 'vue'
import { FileAudioIcon, FileIcon, FileTextIcon, FileVideoIcon, ImageIcon } from '@lucide/vue'
import { fileIcon, mediaKind } from './workspace-files'

/**
 * The leading mark of a file row: the picture itself when there is a `src` to draw it from, the
 * language icon for text, a type icon for everything else.
 */
const props = defineProps<{ mime: string, src?: string, name?: string }>()

const kind = computed(() => mediaKind(props.mime))
const icon = computed(() => ({ image: ImageIcon, pdf: FileTextIcon, audio: FileAudioIcon, video: FileVideoIcon, text: FileIcon, binary: FileIcon })[kind.value])
</script>

<template lang="pug">
img.shrink-0.rounded-sm.border.object-cover(v-if="kind === 'image' && src" :src="src" alt="" loading="lazy" class="size-5")
//- The icon is markstream's own language icon set, matching the chat's code blocks.
span.shrink-0(v-else-if="kind === 'text'" class="[&>svg]:size-4" v-html="fileIcon(name ?? '')")
component.shrink-0.text-muted-foreground(v-else :is="icon" class="size-4")
</template>
