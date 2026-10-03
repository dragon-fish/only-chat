<script setup lang="ts">
import { computed, inject, ref, shallowRef, watch } from 'vue'
import { ExternalLinkIcon } from '@lucide/vue'
import type { Component } from 'vue'
import { toast } from 'vue-sonner'
import PluginConfigForm from '@/client/components/plugin-config-form.vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { useFormChanges } from '@/client/composables/use-form-changes'
import { useRouteOverlay } from '@/client/composables/use-route-overlay'
import { api } from '@/client/lib/api'
import { buildConfigControls, buildConfigPatch, initialFormValues } from '@/client/lib/plugin-config-form'
import type { ClientPluginHost } from '@/client/plugins/host'
import { useSyncStore } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Skeleton } from '@/client/ui/skeleton'
import { Spinner } from '@/client/ui/spinner'
import { findPluginManifest } from '@/shared/plugin-manifests'

const props = defineProps<{ pluginId: string }>()
const sync = useSyncStore()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)

const routeOverlay = useRouteOverlay(() => '/settings/plugins')
const overlayOpen = routeOverlay.open
const leaveGuard = ref<InstanceType<typeof UnsavedChangesGuard> | null>(null)

const manifest = computed(() => findPluginManifest(props.pluginId))
const status = computed(() => sync.pluginConfig[props.pluginId])
const controls = computed(() => (manifest.value ? buildConfigControls(manifest.value, status.value) : []))
const values = ref<Record<string, unknown>>({})
const saving = ref(false)
const loading = ref(true)
/** A plugin that registered its own form replaces the declaration-driven one entirely. */
const custom = shallowRef<Component | null>(null)
const { dirty, capture, markSaved } = useFormChanges(() => values.value)

watch(controls, next => {
  values.value = initialFormValues(next)
  markSaved()
}, { immediate: true })

// Keyed on the plugin, not on mounting: going from one plugin's configuration straight to another's
// reuses this view, and only the prop changes.
watch(() => props.pluginId, async (pluginId) => {
  loading.value = true
  custom.value = null
  try {
    if (!sync.settingsLoaded) await sync.loadSettings()
    const loaded = host ? (await host.ensureConfigRenderer(pluginId) ?? null) as Component | null : null
    if (pluginId === props.pluginId) custom.value = loaded
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    if (pluginId === props.pluginId) loading.value = false
  }
}, { immediate: true })

async function setOverlayOpen(next: boolean) {
  if (next) { routeOverlay.setOpen(true); return }
  if (dirty.value && !(await leaveGuard.value?.confirmLeave())) return
  // A confirmed discard must not trigger the route guard a second time after the leave animation.
  if (dirty.value) markSaved()
  routeOverlay.setOpen(false)
}

async function save() {
  if (!manifest.value || saving.value) return
  saving.value = true
  const snapshot = capture()
  try {
    sync.pluginConfig = await api.updatePluginConfig(props.pluginId, buildConfigPatch(controls.value, values.value))
    markSaved(snapshot)
    toast.success(`已保存 ${manifest.value.name} 的配置`)
    routeOverlay.setOpen(false)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    saving.value = false
  }
}
</script>

<template lang="pug">
ResponsiveOverlay(
  mode="dialog" :open="overlayOpen" :title="manifest?.name ?? '插件配置'" @update:open="setOverlayOpen")
  template(#status)
    UnsavedChangesGuard(ref="leaveGuard" :dirty="dirty")
  Alert(v-if="!manifest" variant="destructive")
    AlertTitle 插件不存在
    AlertDescription 该插件可能已被移除。
  .flex.flex-col.gap-3(v-else-if="loading")
    Skeleton(class="h-5 w-40")
    Skeleton(class="h-10 w-full")
    Skeleton(class="h-10 w-full")
    span.sr-only 加载中…
  component(:is="custom" v-else-if="custom" :key="pluginId" :plugin-id="pluginId")
  .flex.flex-col.gap-5(v-else)
    p.text-sm.text-muted-foreground(v-if="manifest.configIntro")
      | {{ manifest.configIntro.why }}
      template(v-if="manifest.configIntro.where")
        |  {{ manifest.configIntro.where }}
    PluginConfigForm(v-model="values" :controls="controls" :disabled="saving")
    a.inline-flex.items-center.gap-1.text-sm.underline-offset-2(
      v-if="manifest.configIntro?.link" :href="manifest.configIntro.link.href"
      target="_blank" rel="noopener noreferrer" class="hover:underline")
      | {{ manifest.configIntro.link.label }}
      ExternalLinkIcon(class="size-3.5")
  template(#footer v-if="manifest && !custom")
    .flex.items-center.justify-end.gap-2
      Button(type="button" variant="outline" class="min-h-10" :disabled="saving" @click="setOverlayOpen(false)") 取消
      Button(type="button" class="min-h-10" :disabled="!dirty || saving" @click="save")
        Spinner(v-if="saving")
        | 保存
</template>
