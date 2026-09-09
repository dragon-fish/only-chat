<script setup lang="ts">
import AuthLoginView from '@/client/views/auth-login.vue'

definePage({ meta: { guestOnly: true } })
</script>

<template lang="pug">
AuthLoginView
</template>
