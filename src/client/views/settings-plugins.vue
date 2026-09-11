<script lang="ts">
import type { PluginConfigStatusMap, PluginManifest } from '@/shared/plugins'

export interface PluginSettingsRow extends PluginManifest {
  enabled: boolean
  /** Whether the plugin declares configuration at all — not whether it has been filled in. */
  configurable: boolean
  /** A configurable plugin whose stored values do not satisfy its schema. */
  needsConfig: boolean
}

export function pluginSettingsRows(
  manifests: readonly PluginManifest[],
  settings: Readonly<Record<string, boolean>>,
  status: PluginConfigStatusMap = {},
): PluginSettingsRow[] {
  return [...manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(manifest => ({
      ...manifest,
      enabled: settings[manifest.id] === true,
      configurable: manifest.configSchema !== undefined,
      needsConfig: manifest.configSchema !== undefined && status[manifest.id]?.configured !== true,
    }))
}
</script>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { PlugIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import CollectionState from '@/client/components/collection-state.vue'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import { acknowledgedPlugins } from '@/client/lib/settings'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/client/ui/item'
import { Switch } from '@/client/ui/switch'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import { pluginManifests } from '@/client/plugins/loaders'

const sync = useSyncStore()
const plugins = computed(() => pluginSettingsRows(pluginManifests, sync.settings.plugins, sync.pluginConfig))
const pending = reactive(new Map<string, boolean>())

watch(() => sync.settings, settings => {
  for (const key of acknowledgedPlugins(pending, settings.plugins)) {
    const desired = pending.get(key)
    pending.delete(key)
    toast.success(`已${desired ? '启用' : '停用'} ${key}`)
  }
})
watch(() => sync.lastError, error => { if (error) pending.clear() })
watch(() => sync.status, status => {
  if (status !== 'open' && pending.size) {
    pending.clear()
    toast.error(DISCONNECTED_MESSAGE)
  }
})

function toggle(key: string, value: boolean) {
  if (pending.has(key)) return
  sync.lastError = null
  if (sync.status !== 'open' || !sync.send({ type: 'settings.update', settings: { plugins: { [key]: value } } })) {
    sync.lastError = DISCONNECTED_MESSAGE
    return
  }
  pending.set(key, value)
}
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    SettingsBackButton
    span.truncate.text-sm.font-medium 插件
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 插件
        p.text-sm.text-muted-foreground 管理当前可用的功能插件，随时启用或停用。
      CollectionState(:loaded="sync.settingsLoaded" :error="sync.settingsError" :retry="sync.loadSettings" :empty="!plugins.length" empty-title="暂无可用插件" empty-description="当前版本尚未内置功能插件。")
        template(#empty-action)
          Button(as-child variant="outline" class="min-h-10")
            RouterLink(to="/chats") 返回聊天
        ItemGroup(class="gap-2")
          Item(v-for="plugin in plugins" :key="plugin.id" variant="outline")
            ItemMedia(variant="icon")
              PlugIcon
            ItemContent(class="min-w-0")
              ItemTitle.flex.items-center.gap-2(class="break-all")
                span {{ plugin.name }}
                Badge(:variant="plugin.enabled ? 'secondary' : 'outline'") {{ pending.has(plugin.id) ? '更新中…' : plugin.enabled ? '已启用' : '已停用' }}
              ItemDescription {{ plugin.description }}
              ItemDescription(v-if="plugin.needsConfig" class="text-destructive") 尚未配置，工具暂不可用。
            ItemActions
              Button(v-if="plugin.configurable" as-child variant="outline" size="sm")
                RouterLink(:to="`/settings/plugins/${plugin.id}`") 配置
              Switch(:model-value="plugin.enabled" :aria-label="`启用 ${plugin.name}`" :disabled="pending.has(plugin.id) || sync.status !== 'open'" :title="sync.status === 'open' ? undefined : DISCONNECTED_MESSAGE" class="after:-inset-y-3" @update:model-value="toggle(plugin.id, $event)")
</template>
