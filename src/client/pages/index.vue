<script setup lang="ts">
definePage({
  redirect: () => window.matchMedia('(min-width: 768px)').matches ? '/new' : '/chats',
})
</script>

<template lang="pug">
div
</template>
