<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { X } from '@lucide/vue'
import { useSyncStore } from '@/client/stores/sync'
import { routeParamToId } from '@/client/lib/route-params'

const emit = defineEmits<{ navigate: [] }>()
const sync = useSyncStore()
const route = useRoute()
const router = useRouter()

// Two-step confirm: first click arms the row, second click within the window deletes it.
const pendingId = ref<number | null>(null)
let pendingTimer: ReturnType<typeof setTimeout> | undefined

function clearPending() {
  pendingId.value = null
  clearTimeout(pendingTimer)
}

function onDeleteClick(id: number) {
  if (pendingId.value !== id) {
    pendingId.value = id
    clearTimeout(pendingTimer)
    pendingTimer = setTimeout(clearPending, 3000)
    return
  }
  clearPending()
  sync.send({ type: 'session.delete', session_id: id })
  const openSessionId = 'sessionId' in route.params ? route.params.sessionId : undefined
  if (routeParamToId(openSessionId) === id) router.push('/')
}

// A click on the confirm/delete button itself stops propagation, so any click that reaches
// here originated elsewhere and should revert the pending confirm.
onMounted(() => window.addEventListener('click', clearPending))
onUnmounted(() => window.removeEventListener('click', clearPending))
</script>

<template lang="pug">
.flex.h-full.flex-col
  .flex.items-center.justify-between.p-3
    RouterLink.text-sm.font-semibold(to="/" @click="emit('navigate')") 新对话
    RouterLink.text-xs.text-muted-foreground(to="/settings/providers" @click="emit('navigate')") 设置
  .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-2.pb-2
    RouterLink.group.flex.items-center.gap-1.rounded-md.px-2.py-1.text-sm(
      v-for="s in sync.sessionList" :key="s.id" :to="`/c/${s.id}`"
      class="hover:bg-accent" active-class="bg-accent" @click="emit('navigate')")
      span.min-w-0.flex-1.truncate {{ s.title }}
      button.shrink-0(
        v-if="pendingId === s.id"
        class="text-destructive"
        @click.stop.prevent="onDeleteClick(s.id)") 确认删除
      button.inline-flex.shrink-0.items-center.text-muted-foreground(
        v-else
        class="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100"
        @click.stop.prevent="onDeleteClick(s.id)")
        X(class="size-3.5")
</template>
