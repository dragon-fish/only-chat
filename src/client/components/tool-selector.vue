<script setup lang="ts">
import { computed, inject, ref, watchEffect } from 'vue'
import { CircleHelpIcon, WrenchIcon } from '@lucide/vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import { pluginManifests } from '@/client/plugins/loaders'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/client/ui/drawer'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/client/ui/popover'
import { Switch } from '@/client/ui/switch'
import type { PluginConfigStatusMap } from '@/shared/plugins'
import { availablePluginRows, ensureSelectedPlugins, nextToolSelection } from './tool-selector'

const props = defineProps<{
  modelValue: string[]
  plugins: Record<string, boolean>
  pluginConfig: PluginConfigStatusMap
  desktop: boolean
  /** False when the chosen model cannot call tools: the selection is kept but no tool is sent. */
  supported: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [tools: string[]] }>()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const rows = computed(() => availablePluginRows(pluginManifests, props.plugins, props.modelValue, props.pluginConfig))
const selectedCount = computed(() => rows.value.filter(row => row.selected).length)
const triggerHint = computed(() => (
  props.supported ? '选择工具' : '当前模型不支持工具调用，本次不会发送工具定义'
))

watchEffect(() => {
  if (!host) return
  void ensureSelectedPlugins(host, rows.value.filter(row => row.selected).map(row => row.id))
})

/**
 * Which rows show their description. A hover tooltip would be unreachable on a touch screen and
 * would cover the switch it sits next to, so the text opens in place instead.
 */
const explained = ref(new Set<string>())
function toggleHelp(pluginId: string) {
  const next = new Set(explained.value)
  if (!next.delete(pluginId)) next.add(pluginId)
  explained.value = next
}

function toggle(toolIds: string[], on: boolean) {
  emit('update:modelValue', nextToolSelection(props.modelValue, toolIds, on))
}
</script>

<template lang="pug">
component(:is="desktop ? Popover : Drawer")
  component(:is="desktop ? PopoverTrigger : DrawerTrigger" as-child)
    Button(
      variant="ghost" :size="desktop ? 'icon-xs' : 'icon-sm'" aria-label="选择工具" :title="triggerHint"
      :class="['relative size-10', desktop ? 'md:size-6' : '', supported ? '' : 'opacity-50']")
      WrenchIcon(data-icon="inline-start")
      Badge(v-if="selectedCount" variant="secondary" class="absolute -right-1 -top-1 min-w-4 justify-center px-1 text-[10px]") {{ selectedCount }}
  component(
    :is="desktop ? PopoverContent : DrawerContent"
    :align="desktop ? 'start' : undefined" :side="desktop ? 'top' : undefined"
    :class="desktop ? 'w-80' : ''")
    component(:is="desktop ? PopoverHeader : DrawerHeader")
      component(:is="desktop ? PopoverTitle : DrawerTitle") 工具
      component(:is="desktop ? PopoverDescription : DrawerDescription")
        | {{ supported ? '为当前对话选择可调用的工具。' : '当前模型不支持工具调用，本次生成不会发送工具定义。' }}
    .oc-scroll.flex.flex-col.overflow-y-auto(:class="desktop ? 'max-h-80' : 'max-h-96 px-4 pb-6'")
      ItemGroup(class="gap-1")
        Item(v-for="row in rows" :key="row.id" size="sm")
          ItemContent
            ItemTitle
              span {{ row.name }}
              button(
                type="button" class="text-muted-foreground hover:text-foreground shrink-0"
                :aria-label="`${row.name} 说明`" :aria-expanded="explained.has(row.id)"
                @click="toggleHelp(row.id)")
                CircleHelpIcon(class="size-3.5")
            //- The whole text, not the clamped two lines the row shows by default.
            ItemDescription(v-if="explained.has(row.id)" class="line-clamp-none") {{ row.description }}
            ItemDescription(v-if="!row.enabled") 插件已停用；会话快照仍会保留。
            ItemDescription(v-else-if="!row.configured") 尚未配置，请先在插件设置中填写。
            //- A single-tool plugin would only repeat its own title here.
            ItemDescription(v-else-if="row.tools.length > 1") {{ row.tools.map(tool => tool.name).join(' · ') }}
          Switch(
            :model-value="row.selected" :disabled="!row.enabled || !row.configured"
            :aria-label="`启用 ${row.name}`" @update:model-value="toggle(row.toolIds, $event)")
</template>
