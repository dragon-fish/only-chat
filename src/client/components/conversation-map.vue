<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import ConversationMapNode from '@/client/components/conversation-map-node.vue'
import { buildConversationGraph, structureKey, type MapNodeData } from '@/client/components/conversation-map'
import { useSyncStore } from '@/client/stores/sync'

const props = defineProps<{ conversationId: number }>()
const emit = defineEmits<{ locate: [messageId: number] }>()
const sync = useSyncStore()
const { fitView } = useVueFlow()

const messages = computed(() => sync.messages.get(props.conversationId) ?? new Map())
const activePath = computed(() => sync.pathFor(props.conversationId).map(message => message.id))
const streaming = computed(() => sync.isStreaming(props.conversationId))

/**
 * The layout is recomputed only when the tree's shape changes.
 *
 * `structureKey` deliberately ignores content, so the tokens of a streaming reply never reach this
 * watcher; the node card re-reads its own message from the store instead. Highlighting still tracks
 * the head, which is why the active path is part of the key.
 */
const graph = ref(buildConversationGraph(messages.value, activePath.value))
watch(
  () => `${structureKey(messages.value)}#${activePath.value.join(',')}`,
  () => { graph.value = buildConversationGraph(messages.value, activePath.value) },
)

/**
 * Opens on the branch the reader is in, framed whole: the head sits at the bottom, its ancestors
 * and the forks along the way stay visible above it. Framing the head alone leaves the canvas
 * mostly empty and hides where the branches are.
 */
function focusActiveEnd() {
  const path = activePath.value
  void fitView(path.length === 0
    ? { padding: 0.15, maxZoom: 1 }
    : { nodes: path.map(String), padding: 0.2, maxZoom: 1 })
}

function onNodeClick({ node }: { node: { data: MapNodeData } }) {
  if (streaming.value) return
  const target = sync.leafOf(props.conversationId, node.data.messageId)
  // Clicking a node already on the current branch would resolve to the current head: a no-op that
  // should not cost a round trip.
  if (target === sync.conversations.get(props.conversationId)?.head_message_id) return
  sync.send({ type: 'switch_head', conversation_id: props.conversationId, message_id: target })
}

function onNodeDoubleClick({ node }: { node: { data: MapNodeData } }) {
  emit('locate', node.data.messageId)
}

/** Slot props reach the template untyped, and a cast there would be TypeScript in JavaScript. */
function dataOf(value: unknown): MapNodeData {
  return value as MapNodeData
}

defineExpose({ focusActiveEnd })
</script>

<template lang="pug">
VueFlow(
  :nodes="graph.nodes" :edges="graph.edges"
  :nodes-draggable="false" :nodes-connectable="false" :elements-selectable="false"
  :min-zoom="0.1" :max-zoom="2" fit-view-on-init
  class="size-full"
  @nodes-initialized="focusActiveEnd"
  @node-click="onNodeClick"
  @node-double-click="onNodeDoubleClick")
  template(#node-message="nodeProps")
    ConversationMapNode(:data="dataOf(nodeProps.data)" :conversation-id="conversationId")
  Controls(:show-interactive="false")
  MiniMap(pannable zoomable)
</template>

<style>
/* The canvas paints its own ground; without this the host page shows through the grid. */
.vue-flow__pane {
  background-color: var(--color-background);
}
</style>
