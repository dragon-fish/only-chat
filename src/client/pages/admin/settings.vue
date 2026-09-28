<script setup lang="ts">
import AdminSettingsView from '@/client/views/admin-settings.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('站点设置')
</script>

<template lang="pug">
AdminSettingsView
</template>
