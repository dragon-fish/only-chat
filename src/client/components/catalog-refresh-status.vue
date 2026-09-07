<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RefreshCwIcon } from '@lucide/vue'
import { api } from '@/client/lib/api'
import { useConfigStore } from '@/client/stores/config'
import { Button } from '@/client/ui/button'
import { Spinner } from '@/client/ui/spinner'
import type { CatalogStatus } from '@/shared/api'

const emit = defineEmits<{ refreshed: [] }>()
const config = useConfigStore()
const status = ref<CatalogStatus | null>(null)
const refreshing = ref(false)
const error = ref<string | null>(null)
async function load() {
  try { status.value = await api.catalogStatus() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
onMounted(load)
async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  error.value = null
  try {
    await api.refreshCatalog()
    await Promise.all([load(), config.load(), config.refreshSelectedModels(), config.pickerLoaded ? config.loadEnabledModels() : Promise.resolve()])
    emit('refreshed')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { refreshing.value = false }
}
</script>

<template lang="pug">
.flex.flex-col.gap-2
  Button(type="button" variant="outline" :disabled="refreshing" @click="refresh")
    Spinner(v-if="refreshing" data-icon="inline-start")
    RefreshCwIcon(v-else data-icon="inline-start")
    | 刷新模型目录
  .flex.flex-col.gap-1.text-xs.text-muted-foreground
    span.truncate(:title="status?.version ?? ''") 版本：{{ status?.version ?? '尚未加载' }}
    span.truncate 最近成功：{{ status?.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString('zh-CN') : '—' }}
    p.h-8.overflow-y-auto(role="status" aria-live="polite") {{ refreshing ? '正在刷新模型目录…' : error ?? status?.lastError ?? '' }}
</template>
