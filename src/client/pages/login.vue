<script setup lang="ts">
import AuthLoginView from '@/client/views/auth-login.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

definePage({ meta: { guestOnly: true } })
usePageTitle('登录')
</script>

<template lang="pug">
AuthLoginView
</template>
