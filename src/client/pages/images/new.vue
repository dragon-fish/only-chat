<script setup lang="ts">
import ImageStudio from '@/client/views/image-studio.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('图片创作')
</script>
<template><ImageStudio :conversation-id="null" /></template>
