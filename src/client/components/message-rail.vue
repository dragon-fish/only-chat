<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import type { MessageTurn } from '@/client/lib/message-turns'
import { useMessageTurnNav } from '@/client/composables/use-message-turn-nav'

const props = defineProps<{ turns: readonly MessageTurn[] }>()
const { activeId, jump } = useMessageTurnNav(toRef(props, 'turns'))
const rail = ref<HTMLElement | null>(null)
const preview = ref<HTMLElement | null>(null)
const previewTitle = ref<HTMLElement | null>(null)
const previewReply = ref<HTMLElement | null>(null)
const PAD = 8
const TICK = 10
const REACH = 38
let tracking = false
let pointerY = 0
let railTop = 0
let railRight = 0
let hovered = -1
let frame = 0
let openTimer: ReturnType<typeof setTimeout> | undefined
let observer: ResizeObserver | undefined
let changed = new Set<number>()

function tick(index: number) {
  return rail.value?.children[index]?.firstElementChild as HTMLElement | undefined
}

function measure() {
  if (!rail.value) return
  const rect = rail.value.getBoundingClientRect()
  railTop = rect.top
  railRight = rect.right
}

function updatePreview() {
  const turn = props.turns[hovered]
  if (!turn || !preview.value || !rail.value) return
  previewTitle.value!.textContent = turn.prompt || '（空消息）'
  previewReply.value!.textContent = turn.reply
  previewReply.value!.hidden = !turn.reply
  const height = preview.value.offsetHeight
  const center = railTop + PAD + hovered * TICK + TICK / 2 - rail.value.scrollTop
  preview.value.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, center - height / 2))}px`
  preview.value.style.left = `${railRight + 6}px`
}

// Pointer coordinates stay outside Vue's render dependencies. Only nearby ticks receive style
// writes; one shared preview changes when the hovered turn changes, regardless of history length.
function paint() {
  frame = 0
  if (!tracking || !rail.value || !props.turns.length) return
  const y = pointerY - railTop + rail.value.scrollTop
  const index = Math.max(0, Math.min(props.turns.length - 1, Math.floor((y - PAD) / TICK)))
  const nearby = new Set<number>()
  for (let i = Math.max(0, index - 4); i <= Math.min(props.turns.length - 1, index + 4); i++) {
    // Snap the peak to the selected tick so its neighbours stay symmetric within the hit area.
    const distance = Math.abs(i - index) * TICK
    if (distance >= REACH) continue
    const strength = (1 + Math.cos(Math.PI * distance / REACH)) / 2
    nearby.add(i)
    tick(i)?.style.setProperty('--swell', String(strength))
  }
  for (const i of changed) if (!nearby.has(i)) tick(i)?.style.removeProperty('--swell')
  changed = nearby
  if (hovered !== index) {
    tick(hovered)?.removeAttribute('data-hovered')
    hovered = index
    updatePreview()
  }
  tick(index)?.setAttribute('data-hovered', '')
}

function queue() {
  if (tracking && !frame) frame = requestAnimationFrame(paint)
}

function enter(event: PointerEvent) {
  if (event.pointerType === 'touch') return
  tracking = true
  pointerY = event.clientY
  measure()
  rail.value?.setAttribute('data-tracking', '')
  queue()
  openTimer = setTimeout(() => {
    if (tracking && hovered >= 0) preview.value?.setAttribute('data-open', '')
  }, 80)
}

function move(event: PointerEvent) {
  pointerY = event.clientY
  queue()
}

function leave() {
  tracking = false
  clearTimeout(openTimer)
  cancelAnimationFrame(frame)
  frame = 0
  tick(hovered)?.removeAttribute('data-hovered')
  hovered = -1
  rail.value?.removeAttribute('data-tracking')
  preview.value?.removeAttribute('data-open')
  for (const i of changed) tick(i)?.style.removeProperty('--swell')
  changed.clear()
}

function onScroll() {
  updatePreview()
  queue()
}

function focus(index: number) {
  if (tracking) return
  measure()
  hovered = index
  updatePreview()
  preview.value?.setAttribute('data-open', '')
}

function blur() {
  if (!tracking) leave()
}

function keydown(event: KeyboardEvent, index: number) {
  let target: number | undefined
  if (event.key === 'ArrowDown') target = Math.min(index + 1, props.turns.length - 1)
  if (event.key === 'ArrowUp') target = Math.max(index - 1, 0)
  if (event.key === 'Home') target = 0
  if (event.key === 'End') target = props.turns.length - 1
  if (target !== undefined) {
    event.preventDefault()
    const button = rail.value?.children[target] as HTMLElement | undefined
    button?.focus()
  }
  if (event.key === 'Escape') leave()
}

function followActive() {
  if (tracking || !rail.value?.clientHeight) return
  const index = props.turns.findIndex(turn => turn.id === activeId.value)
  if (index < 0) return
  const top = PAD + index * TICK
  // Scroll only this rail, only when needed. scrollIntoView also moves transcript ancestors.
  if (top < rail.value.scrollTop + PAD) rail.value.scrollTop = top - PAD
  else if (top + TICK > rail.value.scrollTop + rail.value.clientHeight - PAD) {
    rail.value.scrollTop = top + TICK + PAD - rail.value.clientHeight
  }
}

const turnIds = computed(() => props.turns.map(turn => turn.id).join(','))
watch(turnIds, () => {
  leave()
  measure()
  followActive()
}, { flush: 'post' })
watch(activeId, followActive, { flush: 'post' })
watch(() => props.turns, updatePreview, { flush: 'post' })
function resize() {
  leave()
  measure()
  followActive()
}
onMounted(() => {
  observer = new ResizeObserver(resize)
  observer.observe(rail.value!)
  window.addEventListener('resize', resize)
  followActive()
})
onBeforeUnmount(() => {
  leave()
  observer?.disconnect()
  window.removeEventListener('resize', resize)
})
</script>

<template lang="pug">
nav.message-rail(
  ref="rail" aria-label="对话目录" data-message-rail
  class="absolute inset-s-0 top-1/2 z-10 hidden max-h-[60%] -translate-y-1/2 flex-col md:flex"
  @pointerenter="enter" @pointermove="move" @pointerleave="leave" @scroll.passive="onScroll")
  button.message-rail-tick(
    v-for="(turn, index) in turns" :key="turn.id" type="button" :data-turn="turn.id"
    :aria-label="`第 ${index + 1} 轮：${turn.prompt || '（空消息）'}`"
    :aria-current="turn.id === activeId ? 'location' : undefined"
    @click="jump(turn.id)" @focus="focus(index)" @blur="blur" @keydown="keydown($event, index)")
    span
Teleport(to="body")
  aside.message-rail-preview(ref="preview" data-message-rail-preview aria-hidden="true" class="hidden md:block")
    p.message-rail-preview-title(ref="previewTitle")
    p.message-rail-preview-reply(ref="previewReply")
</template>

<style scoped>
.message-rail {
  width: 37px;
  padding: 8px 0;
  overflow-y: auto;
  scrollbar-width: none;
  overscroll-behavior: contain;
  border-radius: 0 9px 9px 0;
}
.message-rail::-webkit-scrollbar { display: none; }
.message-rail-tick {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 37px;
  height: 10px;
  padding-left: 8px;
  cursor: pointer;
}
.message-rail-tick:focus-visible { outline: 1px solid var(--ring); outline-offset: -1px; }
.message-rail-tick span {
  width: 6px;
  height: 2px;
  transform-origin: left;
  transform: scaleX(calc(1 + 3.3 * var(--swell, 0)));
  background: color-mix(in oklch, var(--foreground) 25%, transparent);
  transition: transform 140ms ease-out, background 140ms ease-out;
  pointer-events: none;
}
.message-rail:not([data-tracking]) .message-rail-tick[aria-current] span {
  background: color-mix(in oklch, var(--foreground) 90%, transparent);
}
.message-rail[data-tracking] span { transition: transform 100ms ease-out; }
.message-rail[data-tracking] span[data-hovered] { background: var(--foreground); }
.message-rail-preview {
  position: fixed;
  z-index: 50;
  width: min(322px, calc(100vw - 58px));
  padding: 10px 11px 9px;
  border-radius: 12px;
  background: var(--popover);
  box-shadow: 0 8px 28px #0003, inset 0 0 0 1px color-mix(in oklch, var(--foreground) 3%, transparent);
  pointer-events: none;
  opacity: 0;
  transform: translateX(-3px);
  transition: opacity 90ms, transform 90ms;
}
.message-rail-preview[data-open] { opacity: 1; transform: translateX(0); }
.message-rail-preview-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-rail-preview-title { font-size: 13px; line-height: 21px; color: var(--popover-foreground); }
.message-rail-preview-reply {
  font-size: 13px;
  line-height: 21px;
  color: var(--muted-foreground);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 3px;
}
.message-rail-preview-reply[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) {
  .message-rail-tick span, .message-rail[data-tracking] span, .message-rail-preview { transition: none; }
}
</style>
