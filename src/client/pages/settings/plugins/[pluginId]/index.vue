<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SettingsPluginConfigView from '@/client/views/settings-plugin-config.vue'
import SettingsPluginsView from '@/client/views/settings-plugins.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('插件设置')
const route = useRoute('/settings/plugins/[pluginId]/')
const pluginId = computed(() => String(route.params.pluginId))
</script>

<template lang="pug">
SettingsPluginsView
SettingsPluginConfigView(:plugin-id="pluginId")
</template>
