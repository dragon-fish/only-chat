<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import ImageGallery from '@/client/views/image-gallery.vue'

const route = useRoute()
const showsGallery = computed(() => route.path === '/images' || route.path.startsWith('/images/a/'))
const showsOverlay = computed(() => route.path.startsWith('/images/a/'))
</script>

<template>
  <ImageGallery v-if="showsGallery" />
  <RouterView v-if="!showsGallery || showsOverlay" />
</template>
