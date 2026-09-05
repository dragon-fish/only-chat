<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import MessageItem from '@/client/components/message-item.vue'
import type { Message } from '@/shared/models'

const props = defineProps<{ messages: Message[] }>()
const el = ref<HTMLElement | null>(null)
const stick = ref(true)

function onScroll() {
  const e = el.value
  if (!e) return
  stick.value = e.scrollHeight - e.scrollTop - e.clientHeight < 48
}

async function scrollToBottom() {
  if (!stick.value) return
  await nextTick()
  el.value?.scrollTo({ top: el.value.scrollHeight })
}

// `immediate` covers the first paint: the list mounts with a full path already in place, so a lazy
// watch would leave an existing session parked at the top. `onMounted` covers the case where the
// immediate run fires before the element exists.
watch(() => props.messages.map((m) => m.parts.map((p) => ('text' in p ? p.text.length : 0)).join(',')).join('|'), scrollToBottom, { immediate: true })
onMounted(scrollToBottom)
</script>

<template lang="pug">
.oc-scroll.h-full.overflow-y-auto.px-4.py-4(ref="el" @scroll="onScroll")
  .mx-auto.flex.max-w-3xl.flex-col.gap-4
    MessageItem(v-for="m in messages" :key="m.id" :message="m")
</template>
