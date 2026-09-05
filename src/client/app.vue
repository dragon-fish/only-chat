<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppShell from '@/client/components/app-shell.vue'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'

const sync = useSyncStore()
const config = useConfigStore()
const bootError = ref<string | null>(null)

onMounted(async () => {
  sync.connect()
  try {
    await Promise.all([sync.loadSessions(), config.load()])
  } catch (err) {
    bootError.value = err instanceof Error ? err.message : String(err)
  }
})
</script>

<template lang="pug">
AppShell(:boot-error="bootError")
  RouterView
</template>
