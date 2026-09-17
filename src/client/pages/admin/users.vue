<script setup lang="ts">
import AdminUsersView from '@/client/views/admin-users.vue'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('用户管理')
</script>

<template lang="pug">
AdminUsersView
</template>
