import { computed, type Ref } from 'vue'
import type { MessageTurn } from '@/client/lib/message-turns'
import { useMessageScroller, useMessageScrollerVisibility } from '@/client/ui/message-scroller'

/**
 * Where the reader is among the turns, and how to go to one. Must run inside MessageScrollerProvider.
 * MessageList marks every prompt as a scroll anchor, so the scroller's current anchor is the turn
 * being read; above the first anchor there is none, and that is still the first turn.
 */
export function useMessageTurnNav(turns: Ref<readonly MessageTurn[]>) {
  const visibility = useMessageScrollerVisibility()
  const { scrollToMessage } = useMessageScroller()
  const activeId = computed(() => {
    const anchor = Number(visibility.value.currentAnchorId)
    return turns.value.some(turn => turn.id === anchor) ? anchor : turns.value[0]?.id ?? null
  })
  function jump(id: number) {
    scrollToMessage(String(id), { behavior: 'smooth' })
  }
  return { activeId, jump }
}
