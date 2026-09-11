<script setup lang="ts">
import { computed, inject, shallowRef, watch } from 'vue'
import type { Component } from 'vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import type { Message } from '@/shared/models'

const props = defineProps<{ message: Message }>()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const footers = shallowRef<{ pluginId: string, component: Component }[]>([])

/** Only the plugins this message actually called can have anything to say about it. */
const pluginIds = computed(() => {
  if (!host) return []
  const ids = new Set<string>()
  for (const part of props.message.parts) {
    if (part.type !== 'tool_call' && part.type !== 'tool_result') continue
    const owner = host.ownerOf(part.name)
    if (owner) ids.add(owner)
  }
  return [...ids]
})

watch(pluginIds, async (ids) => {
  if (!host || ids.length === 0) {
    footers.value = []
    return
  }
  // A plugin that fails to load loses its footer, not the message it was summarising.
  await Promise.all(ids.map(id => host.ensurePlugin(id).catch(() => {})))
  footers.value = ids.flatMap((pluginId) => {
    const component = host.messageFooter(pluginId) as Component | undefined
    return component ? [{ pluginId, component }] : []
  })
}, { immediate: true })
</script>

<template lang="pug">
component(v-for="footer in footers" :key="footer.pluginId" :is="footer.component" :message="message")
</template>
