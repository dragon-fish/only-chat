<script setup lang="ts">
import AuthRegisterView from '@/client/views/auth-register.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

definePage({ meta: { guestOnly: true } })
usePageTitle('注册')
</script>

<template lang="pug">
AuthRegisterView
</template>
