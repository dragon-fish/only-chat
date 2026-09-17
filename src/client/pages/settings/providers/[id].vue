<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SettingsProviderEditView from '@/client/views/settings-provider-edit.vue'
import { routeParamToId } from '@/client/lib/route-params'
import { usePageTitle } from '@/client/composables/use-page-title'

usePageTitle('供应商设置')
const route = useRoute('/settings/providers/[id]')
const providerId = computed(() => routeParamToId(route.params.id))
</script>

<template lang="pug">
SettingsProviderEditView(:provider-id="providerId")
</template>
