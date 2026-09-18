<script setup lang="ts">
import { nextTick, ref, toRef, watch } from 'vue'
import type { MessageTurn } from '@/client/lib/message-turns'
import { useMessageTurnNav } from '@/client/composables/use-message-turn-nav'
import { cn } from '@/client/lib/utils'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/client/ui/hover-card'

/** Desktop only: one tick per turn at fixed spacing. A long conversation scrolls the rail, never squeezes it. */
const props = defineProps<{ turns: readonly MessageTurn[] }>()
const { activeId, jump } = useMessageTurnNav(toRef(props, 'turns'))
const rail = ref<HTMLElement | null>(null)

// Keep the active tick inside the rail's own viewport. Not scrollIntoView: that would also scroll
// every scrollable ancestor, the transcript included.
watch(activeId, async id => {
  await nextTick()
  const tick = rail.value?.querySelector<HTMLElement>(`[data-turn="${id}"]`)
  if (!rail.value || !tick) return
  const top = tick.offsetTop - rail.value.clientHeight / 2 + tick.offsetHeight / 2
  rail.value.scrollTo({ top, behavior: 'smooth' })
}, { immediate: true })
</script>

<template lang="pug">
nav(
  ref="rail" aria-label="对话目录" data-message-rail
  class="absolute inset-s-1 top-1/2 z-10 hidden max-h-[60%] -translate-y-1/2 flex-col overflow-y-auto py-2 [scrollbar-width:none] md:flex [&::-webkit-scrollbar]:hidden")
  HoverCard(v-for="(turn, index) in turns" :key="turn.id" :open-delay="100" :close-delay="50")
    HoverCardTrigger(as-child)
      button(
        type="button" :data-turn="turn.id" :data-active="turn.id === activeId || undefined"
        :aria-label="`第 ${index + 1} 轮：${turn.prompt || '（空消息）'}`" :aria-current="turn.id === activeId ? 'location' : undefined"
        class="group flex h-3 w-8 shrink-0 items-center px-1.5" @click="jump(turn.id)")
        span(:class="cn('h-0.5 rounded-full transition-all', turn.id === activeId ? 'w-5 bg-foreground' : 'w-3 bg-muted-foreground/40 group-hover:w-4 group-hover:bg-muted-foreground')")
    HoverCardContent(side="right" align="center" :side-offset="8" class="w-72 p-3")
      p.line-clamp-1.text-sm.font-medium {{ turn.prompt || '（空消息）' }}
      p.mt-1.line-clamp-2.text-xs.text-muted-foreground(v-if="turn.reply") {{ turn.reply }}
</template>
