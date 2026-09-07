<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { toast } from 'vue-sonner'
import 'vue-sonner/style.css'
import AppShell from '@/client/components/app-shell.vue'
import { useTheme } from '@/client/composables/use-theme'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import { Toaster } from '@/client/ui/sonner'

const sync = useSyncStore()
const config = useConfigStore()
const { resolved: resolvedTheme } = useTheme()

onMounted(async () => {
  sync.connect()
  // Each collection owns its blocking error and retry action in the relevant content region.
  await Promise.allSettled([sync.loadSettings(), sync.loadSessions(), sync.loadProjects(), config.load()])
})

watch(() => sync.lastError, error => { if (error) toast.error(error) }, { flush: 'sync' })
</script>

<template lang="pug">
AppShell
  RouterView
Toaster(:theme="resolvedTheme" position="top-right" close-button rich-colors)
</template>
