<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AdminAuditUser from '@/client/views/admin-audit-user.vue'
import { routeParamToId } from '@/client/lib/route-params'
import { usePageTitle } from '@/client/composables/use-page-title'
usePageTitle('审计')
const route = useRoute()
const userId = computed(() => {
  const value = (route.params as Record<string, unknown>).userId
  return routeParamToId(typeof value === 'string' ? value : undefined)
})
</script>
<template><AdminAuditUser v-if="userId !== null" :user-id="userId" /></template>
