<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import type { Message } from '@/shared/models'

const props = defineProps<{ message: Message }>()
const sync = useSyncStore()
const siblings = computed(() => sync.siblingsOf(props.message.conversation_id, props.message.id))
const index = computed(() => siblings.value.findIndex((m) => m.id === props.message.id))

function go(delta: number) {
  const target = siblings.value[index.value + delta]
  if (!target) return
  sync.send({
    type: 'switch_head',
    conversation_id: props.message.conversation_id,
    message_id: sync.leafOf(target.conversation_id, target.id),
  })
}
</script>

<template lang="pug">
.inline-flex.items-center.gap-1.text-xs.text-muted-foreground(v-if="siblings.length > 1")
  Button(variant="ghost" size="icon-xs" class="size-10 md:size-6" aria-label="上一个分支" title="上一个分支" :disabled="index <= 0" @click="go(-1)")
    ChevronLeft(data-icon="inline-start" class="size-3.5")
  span {{ index + 1 }} / {{ siblings.length }}
  Button(variant="ghost" size="icon-xs" class="size-10 md:size-6" aria-label="下一个分支" title="下一个分支" :disabled="index >= siblings.length - 1" @click="go(1)")
    ChevronRight(data-icon="inline-end" class="size-3.5")
</template>
