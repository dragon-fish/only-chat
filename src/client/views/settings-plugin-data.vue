<script setup lang="ts">
import { computed, inject, onMounted, shallowRef } from 'vue'
import type { Component } from 'vue'
import { RouterLink } from 'vue-router'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Skeleton } from '@/client/ui/skeleton'
import type { ClientPluginHost } from '@/client/plugins/host'
import { findPluginManifest } from '@/shared/plugin-manifests'

const props = defineProps<{ pluginId: string }>()
const host = inject<ClientPluginHost | null>('clientPluginHost', null)

const manifest = computed(() => findPluginManifest(props.pluginId))
const title = computed(() => manifest.value?.settingsEntry?.label ?? manifest.value?.name ?? '插件')
const panel = shallowRef<Component | null>(null)
const loading = shallowRef(true)

onMounted(async () => {
  try {
    if (host) panel.value = (await host.ensureSettingsPanel(props.pluginId) ?? null) as Component | null
  }
  finally {
    loading.value = false
  }
})
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium {{ title }}
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold {{ title }}
        p.text-sm.text-muted-foreground(v-if="manifest") {{ manifest.description }}

      Alert(v-if="!manifest" variant="destructive")
        AlertTitle 插件不存在
        AlertDescription 该插件可能已被移除。
      .flex.flex-col.gap-2(v-else-if="loading")
        Skeleton(class="h-8 w-full")
        Skeleton(class="h-8 w-full")
      //- A plugin whose client half failed to load still has a settings page; it just has nothing
      //- to manage here, and the link to its configuration is the useful thing to offer.
      Alert(v-else-if="!panel")
        AlertTitle 暂无可管理的内容
        AlertDescription 这个插件没有提供数据管理界面。
      component(:is="panel" v-else :plugin-id="pluginId")

      Button(v-if="manifest" as-child variant="ghost" class="min-h-10 self-start")
        RouterLink(:to="`/settings/plugins/${pluginId}`") 打开 {{ manifest.name }} 的配置
</template>
