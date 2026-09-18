<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, toRef, watch } from 'vue'
import type { MessageTurn } from '@/client/lib/message-turns'
import { useMessageTurnNav } from '@/client/composables/use-message-turn-nav'
import { cn } from '@/client/lib/utils'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/client/ui/hover-card'

/** Desktop only: one tick per turn at fixed spacing. A long conversation scrolls the rail, never squeezes it. */
const props = defineProps<{ turns: readonly MessageTurn[] }>()
const { activeId, jump } = useMessageTurnNav(toRef(props, 'turns'))
const rail = ref<HTMLElement | null>(null)

/**
 * The swell under the pointer. Everything here is arithmetic on fixed spacing — the tick at `index`
 * is centred at `PAD + TICK * index + TICK / 2` — and the length is a `scaleX`, so following the
 * pointer never reads or changes layout. Reading `offsetTop` or animating `width` per move is what
 * made it stutter.
 */
const PAD = 8
const TICK = 12
/** Rest length 12px; under the pointer it doubles; the swell fades out over REACH px either side. */
const SWELL = 1
const REACH = 40
/** The pointer's y within the rail's scrolled content, or null when it is elsewhere. */
const pointerY = ref<number | null>(null)
let pendingY: number | null = null
let frame = 0
function track(event: PointerEvent) {
  if (!rail.value) return
  pendingY = event.clientY - rail.value.getBoundingClientRect().top + rail.value.scrollTop
  // One update per painted frame, however often the pointer reports.
  frame ||= requestAnimationFrame(() => { frame = 0; pointerY.value = pendingY })
}
function leave() {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  pointerY.value = null
}
onBeforeUnmount(() => { if (frame) cancelAnimationFrame(frame) })
/** A raised cosine around the pointer: full swell under it, easing back to rest either side. */
function tickScale(index: number): number {
  if (pointerY.value === null) return 1
  const distance = Math.abs(PAD + TICK * index + TICK / 2 - pointerY.value)
  return distance >= REACH ? 1 : 1 + SWELL * (1 + Math.cos(Math.PI * distance / REACH)) / 2
}

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
  :data-tracking="pointerY !== null || undefined"
  class="group/rail absolute inset-s-1 top-1/2 z-10 hidden max-h-[60%] -translate-y-1/2 flex-col overflow-y-auto py-2 [scrollbar-width:none] md:flex [&::-webkit-scrollbar]:hidden"
  @pointermove="track" @pointerleave="leave")
  HoverCard(v-for="(turn, index) in turns" :key="turn.id" :open-delay="100" :close-delay="50")
    HoverCardTrigger(as-child)
      button(
        type="button" :data-turn="turn.id" :data-active="turn.id === activeId || undefined"
        :aria-label="`第 ${index + 1} 轮：${turn.prompt || '（空消息）'}`" :aria-current="turn.id === activeId ? 'location' : undefined"
        class="flex h-3 w-10 shrink-0 items-center px-1.5" @click="jump(turn.id)")
        //- The current turn is only brighter; length belongs to the pointer. It follows the pointer
        //- with no transition (a transition restarted every frame lags behind) and eases back on leave.
        span(
          :class="cn('h-0.5 w-3 origin-left rounded-full transition-[transform,background-color] duration-200 ease-out will-change-transform group-data-[tracking]/rail:transition-none', turn.id === activeId ? 'bg-foreground' : 'bg-muted-foreground/40')"
          :style="{ transform: `scaleX(${tickScale(index)})` }")
    HoverCardContent(side="right" align="center" :side-offset="8" class="w-72 p-3")
      p.line-clamp-1.text-sm.font-medium {{ turn.prompt || '（空消息）' }}
      p.mt-1.line-clamp-2.text-xs.text-muted-foreground(v-if="turn.reply") {{ turn.reply }}
</template>
