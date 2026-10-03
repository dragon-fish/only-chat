<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/client/ui/field'
import { Switch } from '@/client/ui/switch'
import { api } from '@/client/lib/api'
import { useSyncStore } from '@/client/stores/sync'
import { MEMORY_CONFIG_SCHEMA, MEMORY_PLUGIN_ID } from '../shared'
import MemoryBrowser from './memory-browser.vue'

/** The user's memory: its switch, and what is in it. The page stays usable with the switch off. */
const sync = useSyncStore()
const saving = ref(false)

const enabled = computed(() => MEMORY_CONFIG_SCHEMA.parse(sync.pluginConfig[MEMORY_PLUGIN_ID]?.values ?? {}).user_memory)

onMounted(() => { if (!sync.settingsLoaded) void sync.loadSettings() })

async function toggle(value: boolean) {
  saving.value = true
  try {
    sync.pluginConfig = await api.updatePluginConfig(MEMORY_PLUGIN_ID, { user_memory: value })
  }
  catch (cause) {
    toast.error(cause instanceof Error ? cause.message : '无法保存')
  }
  finally {
    saving.value = false
  }
}
</script>

<template lang="pug">
.flex.flex-col.gap-6
  Field(orientation="horizontal")
    FieldContent
      FieldLabel(for="oc-memory-user") 用户记忆
      FieldDescription 关于你本人的记忆，在所有会话里可用。关闭后模型看不到也写不了它们，下面的记忆仍然保留。Project 和单个会话还可以各自关闭。
    Switch(id="oc-memory-user" :model-value="enabled" :disabled="saving" @update:model-value="toggle")
  MemoryBrowser(:project-id="null")
</template>
