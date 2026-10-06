<script setup lang="ts">
import { inject, onMounted, shallowRef, type Component } from 'vue'
import { FoldVerticalIcon } from '@lucide/vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import type { CheckpointPart } from '@/shared/parts'

/**
 * Where the model's view of the conversation restarts (spec context-compaction §3.8). The plugin
 * that wrote the checkpoint draws it when its client is available; otherwise — plugin unknown,
 * failed to load, or no host in an isolated test — this plain divider stands in, so a checkpoint
 * never renders as an empty reply.
 */
const props = defineProps<{ checkpoint: CheckpointPart }>()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const renderer = shallowRef<Component | null>(null)
onMounted(async () => {
  if (!host) return
  try { renderer.value = ((await host.ensureCheckpointRenderer(props.checkpoint.plugin)) ?? null) as Component | null }
  catch { renderer.value = null }
})
</script>

<template lang="pug">
component(v-if="renderer" :is="renderer" :checkpoint="checkpoint")
.flex.items-center.gap-3.text-xs.text-muted-foreground(v-else role="separator" aria-label="上下文已压缩")
  .h-px.flex-1.bg-border
  span.flex.items-center(class="gap-1.5")
    FoldVerticalIcon(class="size-3.5")
    | 上下文已压缩
  .h-px.flex-1.bg-border
</template>
