<script setup lang="ts">
import { inject, shallowRef, watch } from 'vue'
import type { Component } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Skeleton } from '@/client/ui/skeleton'
import type { ClientPluginHost } from '@/client/plugins/host'

/** One plugin's Project settings tab: its client half is loaded only once the tab is opened. */
const props = defineProps<{ pluginId: string, projectId: number }>()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)

const panel = shallowRef<Component | null>(null)
const loading = shallowRef(true)

watch(() => props.pluginId, async (pluginId) => {
  loading.value = true
  panel.value = null
  try {
    if (host) panel.value = (await host.ensureProjectPanel(pluginId) ?? null) as Component | null
  }
  finally {
    loading.value = false
  }
}, { immediate: true })
</script>

<template lang="pug">
.flex.flex-col.gap-2(v-if="loading")
  Skeleton(class="h-8 w-full")
  Skeleton(class="h-8 w-full")
Alert(v-else-if="!panel" variant="destructive")
  AlertTitle 无法加载
  AlertDescription 这个插件的设置界面没有加载成功，刷新页面后再试。
component(:is="panel" v-else :plugin-id="pluginId" :project-id="projectId")
</template>
