<script setup lang="ts">
import MeIndexView from '@/client/views/me-index.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('我的')
</script>

<template lang="pug">
MeIndexView
</template>
