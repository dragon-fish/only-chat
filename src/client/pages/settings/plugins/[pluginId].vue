<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SettingsPluginConfigView from '@/client/views/settings-plugin-config.vue'

const route = useRoute('/settings/plugins/[pluginId]')
const pluginId = computed(() => String(route.params.pluginId))
</script>

<template lang="pug">
SettingsPluginConfigView(:plugin-id="pluginId")
</template>
