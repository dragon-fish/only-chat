<script setup lang="ts">
import { onMounted } from 'vue'
import AppShell from '@/client/components/app-shell.vue'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'

const sync = useSyncStore()
const config = useConfigStore()

onMounted(async () => {
  sync.connect()
  await Promise.all([sync.loadSessions(), config.load()])
})
</script>

<template lang="pug">
AppShell
  RouterView
</template>
