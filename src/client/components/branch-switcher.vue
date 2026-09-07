<script setup lang="ts">
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import type { Message } from '@/shared/models'

const props = defineProps<{ message: Message }>()
const sync = useSyncStore()
const siblings = computed(() => sync.siblingsOf(props.message.session_id, props.message.id))
const index = computed(() => siblings.value.findIndex((m) => m.id === props.message.id))

function go(delta: number) {
  const target = siblings.value[index.value + delta]
  if (target) sync.send({ type: 'switch_head', session_id: props.message.session_id, message_id: leafOf(target) })
}

/** Switching to a sibling shows that sibling's deepest descendant along newest children. */
function leafOf(m: Message): number {
  const b = sync.messages.get(m.session_id)
  if (!b) return m.id
  let cur = m
  for (;;) {
    const child = [...b.values()].filter((x) => x.parent_id === cur.id).sort((a, c) => c.seq - a.seq)[0]
    if (!child) break
    cur = child
  }
  return cur.id
}
</script>

<template lang="pug">
.inline-flex.items-center.gap-1.text-xs.text-muted-foreground(v-if="siblings.length > 1")
  Button(variant="ghost" size="icon-xs" class="size-10 md:size-6" aria-label="上一个分支" title="上一个分支" :disabled="index <= 0" @click="go(-1)")
    ChevronLeft(data-icon="inline-start")
  span {{ index + 1 }} / {{ siblings.length }}
  Button(variant="ghost" size="icon-xs" class="size-10 md:size-6" aria-label="下一个分支" title="下一个分支" :disabled="index >= siblings.length - 1" @click="go(1)")
    ChevronRight(data-icon="inline-end")
</template>
