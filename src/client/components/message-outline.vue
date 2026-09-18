<script setup lang="ts">
import { ref, toRef } from 'vue'
import { ListIcon } from '@lucide/vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import type { MessageTurn } from '@/client/lib/message-turns'
import { useMessageTurnNav } from '@/client/composables/use-message-turn-nav'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/ui/button'

/**
 * Mobile only: the transcript scrolls in its own container, so iOS's tap-the-status-bar never
 * reaches it. The outline is the way back to the top, and to any turn in between.
 */
const props = defineProps<{ turns: readonly MessageTurn[] }>()
const { activeId, jump } = useMessageTurnNav(toRef(props, 'turns'))
const open = ref(false)

function go(id: number) {
  open.value = false
  jump(id)
}
</script>

<template lang="pug">
Button(
  variant="secondary" size="icon" aria-label="对话目录" data-message-outline
  class="absolute inset-e-4 bottom-4 z-10 size-10 border border-border bg-background shadow-sm md:hidden"
  @click="open = true")
  ListIcon
ResponsiveOverlay(:open="open" title="对话目录" @update:open="open = $event")
  ol.flex.flex-col.gap-1
    li(v-for="(turn, index) in turns" :key="turn.id")
      button(
        type="button" :data-turn="turn.id" :aria-current="turn.id === activeId ? 'location' : undefined"
        :class="cn('flex min-h-12 w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left', turn.id === activeId ? 'bg-muted' : 'hover:bg-muted/60')"
        @click="go(turn.id)")
        span.line-clamp-1.text-sm.font-medium {{ index + 1 }}. {{ turn.prompt || '（空消息）' }}
        span.line-clamp-1.text-xs.text-muted-foreground(v-if="turn.reply") {{ turn.reply }}
</template>
