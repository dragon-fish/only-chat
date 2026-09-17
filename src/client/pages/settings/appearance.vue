<script setup lang="ts">
import SettingsAppearanceView from '@/client/views/settings-appearance.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('外观设置')
</script>

<template lang="pug">
SettingsAppearanceView
</template>
