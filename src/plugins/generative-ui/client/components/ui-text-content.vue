<script setup lang="ts">
import { computed } from 'vue'
import MarkdownRender from 'markstream-vue'
import { useTheme } from '@/client/composables/use-theme'
import type { NodeProps } from '../runtime'

type Size = 'small' | 'default' | 'large' | 'small-heavy' | 'large-heavy'
const { props } = defineProps<NodeProps<{ text?: string, size?: Size }>>()
const { resolved } = useTheme()
const size = computed(() => props.size ?? 'default')
/** Headings and labels are one line of plain text; markdown's paragraph margins only get in the way. */
const plain = computed(() => size.value.endsWith('-heavy'))
const SIZE: Record<Size, string> = {
  'small': 'text-xs text-muted-foreground',
  'default': 'text-sm',
  'large': 'text-base',
  'small-heavy': 'text-sm font-semibold',
  'large-heavy': 'text-lg font-semibold leading-snug',
}
</script>

<template lang="pug">
.min-w-0.break-words(v-if="plain" :class="SIZE[size]") {{ props.text }}
.oc-genui-markdown.min-w-0(v-else :class="SIZE[size]")
  MarkdownRender(
    mode="chat" :content="String(props.text ?? '')" :final="true" :smooth-streaming="false"
    :is-dark="resolved === 'dark'")
</template>

<style scoped>
/* markstream sizes its nodes from --ms-text-body (16px); the size class on the wrapper must win. */
.oc-genui-markdown :deep(.markdown-renderer) { --ms-text-body: 1em; font-size: inherit; color: inherit; }
.oc-genui-markdown :deep(p) { margin-block: 0.25rem; }
.oc-genui-markdown :deep(> div > :first-child) { margin-top: 0; }
.oc-genui-markdown :deep(> div > :last-child) { margin-bottom: 0; }
</style>
