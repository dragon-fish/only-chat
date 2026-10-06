<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownRender from 'markstream-vue'
import type { NodeRendererProps } from 'markstream-vue'
import { ChevronRightIcon, FoldVerticalIcon } from '@lucide/vue'
import { useTheme } from '@/client/composables/use-theme'
import { cn } from '@/client/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import type { CheckpointPart } from '@/shared/parts'
import { checkpointLabel, compactionDataOf } from './compress'

/** The divider this plugin's checkpoints show as, opening onto the summary that replaced the history. */
const props = defineProps<{ checkpoint: CheckpointPart }>()
const { resolved: resolvedTheme } = useTheme()
const codeBlockProps: NonNullable<NodeRendererProps['codeBlockProps']> = {
  theme: { light: 'one-light', dark: 'one-dark-pro' },
}
const open = ref(false)
const data = computed(() => compactionDataOf(props.checkpoint))
const label = computed(() => checkpointLabel(data.value))
</script>

<template lang="pug">
Collapsible(v-model:open="open" :disabled="!data")
  .flex.items-center.gap-3.text-xs.text-muted-foreground
    .h-px.flex-1.bg-border
    CollapsibleTrigger(as-child)
      button.flex.min-h-10.items-center.rounded.px-2(
        type="button" class="gap-1.5 hover:text-foreground disabled:hover:text-muted-foreground md:min-h-6"
        :aria-label="data ? `${label}，${open ? '收起' : '展开'}摘要` : label")
        FoldVerticalIcon(class="size-3.5")
        span {{ label }}
        ChevronRightIcon(v-if="data" :class="cn('size-3.5 transition-transform', open && 'rotate-90')")
    .h-px.flex-1.bg-border
  CollapsibleContent(v-if="data")
    .mt-2.flex.flex-col.gap-3.rounded-lg.border.p-3.text-sm(class="bg-muted/40")
      .flex.flex-col.gap-1(v-if="data.focus")
        p.text-xs.text-muted-foreground 重点说明
        p.whitespace-pre-wrap.break-words {{ data.focus }}
      .flex.flex-col.gap-1
        p.text-xs.text-muted-foreground 摘要
        MarkdownRender(
          mode="chat" :content="data.summary" :final="true" :smooth-streaming="false"
          :is-dark="resolvedTheme === 'dark'" :code-block-props="codeBlockProps")
</template>
