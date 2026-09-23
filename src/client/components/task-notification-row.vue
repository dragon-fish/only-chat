<script setup lang="ts">
import { inject, onMounted, shallowRef, type Component } from 'vue'
import { BellIcon, CircleAlertIcon, CircleSlashIcon } from '@lucide/vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import type { TaskNotificationPart } from '@/shared/parts'

const props = defineProps<{ notification: TaskNotificationPart }>()
// Same injection as tool-part-renderer.vue: absent in isolated component tests, which fall back to text.
const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const renderer = shallowRef<Component | null>(null)
onMounted(async () => {
  if (!host) return
  try { renderer.value = ((await host.ensureNotificationRenderer(props.notification.plugin_id)) ?? null) as Component | null }
  catch { renderer.value = null }
})
const LABEL = { completed: '后台任务完成', failed: '后台任务失败', cancelled: '后台任务已取消' } as const
</script>

<template lang="pug">
.flex.flex-col.gap-2.rounded-lg.border.border-dashed.px-3.py-2.text-sm.text-muted-foreground(role="status")
  .flex.items-center.gap-2
    CircleAlertIcon(v-if="notification.status === 'failed'" class="size-4 text-destructive")
    CircleSlashIcon(v-else-if="notification.status === 'cancelled'" class="size-4")
    BellIcon(v-else class="size-4")
    span {{ LABEL[notification.status] }}
  component(v-if="renderer" :is="renderer" :notification="notification")
  p.whitespace-pre-wrap.break-words.text-xs(v-else) {{ notification.text }}
</template>
