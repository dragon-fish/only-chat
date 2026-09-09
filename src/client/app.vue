<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
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
const router = useRouter()
const { resolved: resolvedTheme } = useTheme()
const guestOnly = computed(() => route.meta.guestOnly === true)
const authKey = computed(() => {
  const current = auth.authSession
  return auth.ready && current ? `${current.user.id}:${current.session.id}` : null
})
let activeAuthKey: string | null = null

watch(authKey, async key => {
  if (key === activeAuthKey) return
  activeAuthKey = key
  sync.reset()
  config.reset()
  if (!key) {
    if (auth.ready && route.meta.requiresAuth) {
      await router.replace({ path: '/login', query: { redirect: route.fullPath } })
    }
    return
  }
  sync.connect()
  // Each collection owns its blocking error and retry action in the relevant content region.
  await Promise.allSettled([sync.loadSettings(), sync.loadConversations(), sync.loadProjects(), config.load()])
}, { immediate: true, flush: 'sync' })

onBeforeUnmount(() => {
  sync.reset()
  config.reset()
})

watch(() => sync.lastError, error => { if (error) toast.error(error) }, { flush: 'sync' })
</script>

<template lang="pug">
RouterView(v-if="guestOnly")
AppShell(v-else)
  RouterView
Toaster(:theme="resolvedTheme" position="top-right" close-button rich-colors)
</template>
