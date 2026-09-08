<script setup lang="ts">
import { computed, inject, watchEffect } from 'vue'
import { WrenchIcon } from '@lucide/vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import { pluginManifests } from '@/client/plugins/loaders'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/client/ui/drawer'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/client/ui/popover'
import { Switch } from '@/client/ui/switch'
import { availablePluginRows, nextToolSelection } from './tool-selector'

const props = defineProps<{
  modelValue: string[]
  plugins: Record<string, boolean>
  desktop: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [tools: string[]] }>()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const rows = computed(() => availablePluginRows(pluginManifests, props.plugins, props.modelValue))
const selectedCount = computed(() => props.modelValue.length)

watchEffect(() => {
  if (!host) return
  const pluginIds = new Set(rows.value.filter(row => row.selected).map(row => row.pluginId))
  for (const pluginId of pluginIds) void host.ensurePlugin(pluginId)
})

function toggle(toolId: string, on: boolean) {
  emit('update:modelValue', nextToolSelection(props.modelValue, toolId, on))
}
</script>

<template lang="pug">
template(v-if="desktop")
  Popover
    PopoverTrigger(as-child)
      Button(variant="ghost" size="icon-xs" class="relative size-10 md:size-6" aria-label="选择工具" title="选择工具")
        WrenchIcon(data-icon="inline-start")
        Badge(v-if="selectedCount" variant="secondary" class="absolute -right-1 -top-1 min-w-4 justify-center px-1 text-[10px]") {{ selectedCount }}
    PopoverContent(align="start" side="top" class="w-80")
      PopoverHeader
        PopoverTitle 工具
        PopoverDescription 为当前对话选择可调用的工具。
      ItemGroup(class="gap-1")
        Item(v-for="row in rows" :key="row.id" size="sm")
          ItemContent
            ItemTitle {{ row.pluginName }}
            ItemDescription {{ row.pluginDescription }}
            ItemDescription(v-if="!row.enabled") 插件已停用；会话快照仍会保留。
          Switch(:model-value="row.selected" :disabled="!row.enabled" :aria-label="`启用工具 ${row.pluginName}`" @update:model-value="toggle(row.id, $event)")
template(v-else)
  Drawer
    DrawerTrigger(as-child)
      Button(variant="ghost" size="icon-sm" class="relative size-10" aria-label="选择工具")
        WrenchIcon(data-icon="inline-start")
        Badge(v-if="selectedCount" variant="secondary" class="absolute -right-1 -top-1 min-w-4 justify-center px-1 text-[10px]") {{ selectedCount }}
    DrawerContent
      DrawerHeader
        DrawerTitle 工具
        DrawerDescription 为当前对话选择可调用的工具。
      .oc-scroll.flex.max-h-96.flex-col.overflow-y-auto.px-4.pb-6
        ItemGroup(class="gap-1")
          Item(v-for="row in rows" :key="row.id" size="sm")
            ItemContent
              ItemTitle {{ row.pluginName }}
              ItemDescription {{ row.pluginDescription }}
              ItemDescription(v-if="!row.enabled") 插件已停用；会话快照仍会保留。
            Switch(:model-value="row.selected" :disabled="!row.enabled" :aria-label="`启用工具 ${row.pluginName}`" @update:model-value="toggle(row.id, $event)")
</template>
