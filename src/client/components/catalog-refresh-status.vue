<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RefreshCwIcon } from '@lucide/vue'
import { api } from '@/client/lib/api'
import { useAuthStore } from '@/client/stores/auth'
import { useConfigStore } from '@/client/stores/config'
import { Button } from '@/client/ui/button'
import { Spinner } from '@/client/ui/spinner'
import type { CatalogStatus } from '@/shared/api'
import { isAuthAdmin } from '@/shared/auth'

const emit = defineEmits<{ refreshed: [] }>()
const config = useConfigStore()
const auth = useAuthStore()
const canRefresh = computed(() => isAuthAdmin(auth.authUser))
const status = ref<CatalogStatus | null>(null)
const refreshing = ref(false)
const error = ref<string | null>(null)
const STORAGE_KEY = 'oc.catalog-refresh-instance'
let tracking = 0
async function load() {
  try { status.value = await api.catalogStatus() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 1000))
function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* Catalog refresh remains usable when storage is unavailable. */ }
}
async function finishRefresh() {
  await Promise.all([load(), config.load(), config.refreshSelectedModels(), config.pickerLoaded ? config.loadEnabledModelList() : Promise.resolve()])
  emit('refreshed')
}
async function track(instanceId: string) {
  const token = ++tracking
  refreshing.value = true
  error.value = null
  try {
    while (token === tracking) {
      const job = await api.catalogRefreshStatus(instanceId)
      if (job.status === 'complete') {
        remember(null)
        await finishRefresh()
        return
      }
      if (job.status === 'errored' || job.status === 'terminated') {
        remember(null)
        error.value = job.error ?? '模型目录刷新失败。'
        return
      }
      await pause()
    }
  } catch (cause) {
    remember(null)
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (token === tracking) refreshing.value = false }
}
onMounted(() => {
  void load()
  if (!canRefresh.value) return
  try {
    const instanceId = localStorage.getItem(STORAGE_KEY)
    if (instanceId) void track(instanceId)
  } catch { /* ignore */ }
})
onBeforeUnmount(() => { tracking++ })
async function refresh() {
  if (refreshing.value) return
  try {
    const { instanceId } = await api.refreshCatalog()
    remember(instanceId)
    await track(instanceId)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
</script>

<template lang="pug">
.flex.flex-col.gap-2
  Button(v-if="canRefresh" type="button" variant="outline" :disabled="refreshing" @click="refresh")
    Spinner(v-if="refreshing" data-icon="inline-start")
    RefreshCwIcon(v-else data-icon="inline-start")
    | 刷新模型目录
  .flex.flex-col.gap-1.text-xs.text-muted-foreground
    span.truncate(:title="status?.version ?? ''") 版本：{{ status?.version ?? '尚未加载' }}
    span.truncate 最近成功：{{ status?.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString('zh-CN') : '—' }}
    p.h-8.overflow-y-auto(role="status" aria-live="polite") {{ refreshing ? '正在刷新模型目录…' : error ?? status?.lastError ?? '' }}
</template>
