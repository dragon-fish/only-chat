<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppShell from '@/client/components/app-shell.vue'
import { api } from '@/client/lib/api'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'

const sync = useSyncStore()
const config = useConfigStore()
const bootError = ref<string | null>(null)

onMounted(async () => {
  sync.connect()
  try {
    // The plugin switches render from settings, so the client needs them before first paint.
    const [me] = await Promise.all([api.me(), sync.loadSessions(), sync.loadProjects(), config.load()])
    sync.settings = me.settings
  } catch (err) {
    bootError.value = err instanceof Error ? err.message : String(err)
  }
})
</script>

<template lang="pug">
AppShell(:boot-error="bootError")
  RouterView
</template>
