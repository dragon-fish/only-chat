<script setup lang="ts">
import { computed, inject, onMounted, ref, shallowRef, watch } from 'vue'
import { ExternalLinkIcon, PlugIcon } from '@lucide/vue'
import type { Component } from 'vue'
import { toast } from 'vue-sonner'
import PluginConfigForm from '@/client/components/plugin-config-form.vue'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { useFormChanges } from '@/client/composables/use-form-changes'
import { api } from '@/client/lib/api'
import { buildConfigControls, buildConfigPatch, initialFormValues } from '@/client/lib/plugin-config-form'
import type { ClientPluginHost } from '@/client/plugins/host'
import { useSyncStore } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Spinner } from '@/client/ui/spinner'
import { findPluginManifest } from '@/shared/plugin-manifests'

const props = defineProps<{ pluginId: string }>()
const sync = useSyncStore()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)

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

onMounted(async () => {
  try {
    if (!sync.settingsLoaded) await sync.loadSettings()
    if (host) custom.value = (await host.ensureConfigRenderer(props.pluginId) ?? null) as Component | null
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    loading.value = false
  }
})

async function save() {
  if (!manifest.value) return
  saving.value = true
  const snapshot = capture()
  try {
    sync.pluginConfig = await api.updatePluginConfig(props.pluginId, buildConfigPatch(controls.value, values.value))
    markSaved(snapshot)
    toast.success(`已保存 ${manifest.value.name} 的配置`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    saving.value = false
  }
}
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    SettingsBackButton(to="/settings/plugins" label="返回插件列表" always-visible)
    span.truncate.text-sm.font-medium {{ manifest?.name ?? '插件配置' }}
  UnsavedChangesGuard(:dirty="dirty")
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      Alert(v-if="!manifest")
        PlugIcon
        AlertTitle 插件不存在
        AlertDescription 该插件可能已被移除。
      template(v-else)
        .flex.flex-col.gap-2
          h1.text-2xl.font-semibold {{ manifest.name }}
          p.text-sm.text-muted-foreground {{ manifest.description }}
        .flex.justify-center.py-10(v-if="loading")
          Spinner
        component(:is="custom" v-else-if="custom" :plugin-id="pluginId")
        Card(v-else)
          CardHeader
            CardTitle 配置
            CardDescription(v-if="manifest.configIntro")
              | {{ manifest.configIntro.why }}
              template(v-if="manifest.configIntro.where")
                |  {{ manifest.configIntro.where }}
          CardContent.flex.flex-col.gap-5
            PluginConfigForm(v-model="values" :controls="controls" :disabled="saving")
            a.inline-flex.items-center.gap-1.text-sm.underline-offset-2(
              v-if="manifest.configIntro?.link" :href="manifest.configIntro.link.href"
              target="_blank" rel="noopener noreferrer" class="hover:underline")
              | {{ manifest.configIntro.link.label }}
              ExternalLinkIcon(class="size-3.5")
          CardFooter.justify-end
            Button(:disabled="!dirty || saving" @click="save")
              Spinner(v-if="saving")
              | 保存
</template>
