<script setup lang="ts">
import SettingsPluginsView from '@/client/views/settings-plugins.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('插件设置')
</script>

<template lang="pug">
SettingsPluginsView
</template>
