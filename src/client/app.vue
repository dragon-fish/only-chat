<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import 'vue-sonner/style.css'
import AppShell from '@/client/components/app-shell.vue'
import { useTheme } from '@/client/composables/use-theme'
import { useSyncStore } from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import { useAuthStore } from '@/client/stores/auth'
import { Toaster } from '@/client/ui/sonner'

const sync = useSyncStore()
const config = useConfigStore()
const auth = useAuthStore()
const route = useRoute()
const { resolved: resolvedTheme } = useTheme()
const guestOnly = computed(() => route.meta.guestOnly === true)

onMounted(async () => {
  if (!auth.ready) await auth.refresh()
  if (!auth.authUser) return
  sync.connect()
  // Each collection owns its blocking error and retry action in the relevant content region.
  await Promise.allSettled([sync.loadSettings(), sync.loadConversations(), sync.loadProjects(), config.load()])
})

watch(() => sync.lastError, error => { if (error) toast.error(error) }, { flush: 'sync' })
</script>

<template lang="pug">
RouterView(v-if="guestOnly")
AppShell(v-else)
  RouterView
Toaster(:theme="resolvedTheme" position="top-right" close-button rich-colors)
</template>
