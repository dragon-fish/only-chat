<script setup lang="ts">
import { computed, inject, shallowRef, watch, type Component } from 'vue'
import { XIcon } from '@lucide/vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Spinner } from '@/client/ui/spinner'
import type { WorkspaceTabEntry } from '@/shared/plugins'

/**
 * The shell of the workspace panel: a tab strip from the manifests and whatever component the
 * active tab's plugin registered. It knows nothing about browsers or files; plugins own the tabs.
 */
const props = defineProps<{
  tabs: readonly WorkspaceTabEntry[]
  active: string | null
  conversationId: number | null
  projectId: number | null
  /** The desktop column has its own close control; the mobile overlay already has one. */
  closable?: boolean
}>()
const emit = defineEmits<{ 'update:active': [pluginId: string]; close: [] }>()

const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const renderer = shallowRef<Component | null>(null)
const loading = shallowRef(false)
const failed = shallowRef(false)
const activeTab = computed(() => props.tabs.find(tab => tab.pluginId === props.active) ?? null)

watch(() => props.active, async (pluginId) => {
  renderer.value = null
  failed.value = false
  if (!host || pluginId === null) return
  loading.value = true
  try { renderer.value = (await host.ensureWorkspacePanel(pluginId) ?? null) as Component | null }
  catch { failed.value = true }
  finally { loading.value = false }
}, { immediate: true })
</script>

<template lang="pug">
.flex.h-full.min-h-0.flex-col
  .flex.shrink-0.items-center.gap-1.border-b.px-2(role="tablist" aria-label="工作区")
    Button(
      v-for="tab in tabs" :key="tab.pluginId" type="button" variant="ghost" size="sm"
      role="tab" :aria-selected="tab.pluginId === active" :data-state="tab.pluginId === active ? 'active' : 'inactive'"
      class="min-h-10 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground text-muted-foreground"
      @click="emit('update:active', tab.pluginId)") {{ tab.label }}
    Button(
      v-if="closable" type="button" variant="ghost" size="icon-xs" class="ml-auto min-h-8 min-w-8"
      title="收起工作区" aria-label="收起工作区" @click="emit('close')")
      XIcon
  .min-h-0.flex-1(role="tabpanel")
    .flex.h-full.items-center.justify-center.text-sm.text-muted-foreground(v-if="loading")
      Spinner(class="mr-2 size-4")
      | 正在加载 {{ activeTab?.label }}…
    Empty(v-else-if="failed || (activeTab && !renderer)" class="h-full")
      EmptyHeader
        EmptyTitle 这个页签暂时打不开
        EmptyDescription {{ activeTab?.label }} 的界面没有加载成功，刷新页面再试。
    component(
      v-else-if="renderer" :is="renderer" :key="active"
      :conversation-id="conversationId" :project-id="projectId")
    Empty(v-else class="h-full")
      EmptyHeader
        EmptyTitle 工作区是空的
        EmptyDescription 启用带工作区页签的插件后，它们会出现在这里。
</template>
