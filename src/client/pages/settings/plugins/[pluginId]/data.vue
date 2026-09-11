<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SettingsPluginDataView from '@/client/views/settings-plugin-data.vue'

const route = useRoute('/settings/plugins/[pluginId]/data')
const pluginId = computed(() => String(route.params.pluginId))
</script>

<template lang="pug">
SettingsPluginDataView(:plugin-id="pluginId")
</template>
