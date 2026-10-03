<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Switch } from '@/client/ui/switch'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import { MEMORY_PLUGIN_ID, MEMORY_PROJECT_CONFIG_SCHEMA } from '../shared'
import MemoryBrowser from './memory-browser.vue'

/** A Project's memory tab: its two switches, which save at once, and the Project's memories. */
const props = defineProps<{ pluginId: string, projectId: number }>()
const sync = useSyncStore()

const project = computed(() => sync.projects.get(props.projectId))
const settings = computed(() => MEMORY_PROJECT_CONFIG_SCHEMA.parse(project.value?.plugin_settings?.[MEMORY_PLUGIN_ID] ?? {}))
const connected = computed(() => sync.status === 'open')

function save(key: 'project_memory' | 'use_user_memory', value: boolean) {
  sync.lastError = null
  if (!connected.value || !sync.send({
    type: 'project.update',
    project_id: props.projectId,
    plugin_settings: { [MEMORY_PLUGIN_ID]: { ...settings.value, [key]: value } },
  })) sync.lastError = DISCONNECTED_MESSAGE
}
</script>

<template lang="pug">
.flex.flex-col.gap-6
  FieldGroup
    Field(orientation="horizontal")
      FieldContent
        FieldLabel(for="oc-memory-project") 项目记忆
        FieldDescription 只属于这个 Project 的记忆，这里的会话都能用。
      Switch(
        id="oc-memory-project" :model-value="settings.project_memory" :disabled="!connected"
        :title="connected ? undefined : DISCONNECTED_MESSAGE" @update:model-value="save('project_memory', $event)")
    Field(orientation="horizontal")
      FieldContent
        FieldLabel(for="oc-memory-use-user") 在这个 Project 中使用用户记忆
        FieldDescription
          | 让这里的会话也能读写关于你本人的记忆。
          RouterLink(class="underline underline-offset-4" to="/settings/plugins/memory/data") 查看用户记忆
      Switch(
        id="oc-memory-use-user" :model-value="settings.use_user_memory" :disabled="!connected"
        :title="connected ? undefined : DISCONNECTED_MESSAGE" @update:model-value="save('use_user_memory', $event)")
  MemoryBrowser(:project-id="projectId")
</template>
