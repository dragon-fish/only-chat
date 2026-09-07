<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SettingsProviderEditView from '@/client/views/settings-provider-edit.vue'
import { routeParamToId } from '@/client/lib/route-params'

const route = useRoute('/settings/providers/[id]')
const providerId = computed(() => routeParamToId(route.params.id))
</script>

<template lang="pug">
SettingsProviderEditView(:key="providerId ?? 'invalid'" :provider-id="providerId")
</template>
