<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { PlusIcon } from '@lucide/vue'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import CollectionState from '@/client/components/collection-state.vue'
import ProviderCreateDialog from '@/client/components/provider-create-dialog.vue'
import CatalogRefreshStatus from '@/client/components/catalog-refresh-status.vue'
import { useConfigStore } from '@/client/stores/config'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { Separator } from '@/client/ui/separator'
import type { ProviderWithInterfaces } from '@/shared/models'

defineProps<{ selectedProviderId?: number | null }>()
const emit = defineEmits<{ catalogRefreshed: [] }>()
const config = useConfigStore()
const router = useRouter()
const query = ref('')
const createOpen = ref(false)
const loading = ref(!config.loaded)
const loadError = ref<string | null>(null)
const visibleProviders = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return config.providerRecords.filter(provider => [provider.name, ...provider.interfaces.map(endpoint => endpoint.protocol)].some(value => value.toLocaleLowerCase().includes(search)))
})
async function load() {
  loading.value = !config.loaded
  loadError.value = null
  try { if (!config.loaded) await config.load() }
  catch (error) { loadError.value = error instanceof Error ? error.message : String(error) }
  finally { loading.value = false }
}
onMounted(load)
async function created(provider: ProviderWithInterfaces) {
  createOpen.value = false
  try {
    await config.load()
    toast.success('已添加供应商')
    await router.push(`/settings/providers/${provider.id}`)
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
}
</script>

<template lang="pug">
nav.flex.h-full.min-h-0.flex-col(aria-label="供应商")
  .flex.shrink-0.flex-col.gap-4.p-4
    h1.text-lg.font-semibold 模型服务
    FieldGroup(class="gap-3")
      Field
        FieldLabel.sr-only(for="provider-search") 搜索供应商
        Input#provider-search(v-model="query" type="search" placeholder="搜索供应商…" class="min-h-10")
    Button(variant="outline" class="min-h-10" @click="createOpen = true")
      PlusIcon(data-icon="inline-start")
      | 添加供应商
    CatalogRefreshStatus(@refreshed="emit('catalogRefreshed')")
  Separator
  .oc-scroll.min-h-0.flex-1.overflow-y-auto.p-2
    CollectionState(:loaded="!loading" :error="loadError" :retry="load" :empty="!visibleProviders.length" :empty-title="query ? '没有匹配的供应商' : '尚未添加供应商'" empty-description="从目录选择供应商，或配置自定义端点。")
      template(#empty-action)
        Button(v-if="query" variant="outline" class="min-h-10" @click="query = ''") 清除搜索
        Button(v-else variant="outline" class="min-h-10" @click="createOpen = true") 添加供应商
      ItemGroup(class="gap-1")
        Item(v-for="provider in visibleProviders" :key="provider.id" as-child size="sm" :variant="selectedProviderId === provider.id ? 'muted' : 'default'")
          RouterLink(:to="`/settings/providers/${provider.id}`" :aria-current="selectedProviderId === provider.id ? 'page' : undefined")
            ItemContent
              ItemTitle {{ provider.name }}
              ItemDescription {{ provider.interfaces.map(endpoint => endpoint.protocol).join(' · ') || '待配置接口' }}
              .flex.flex-wrap.gap-1
                Badge(:variant="provider.enabled ? 'secondary' : 'outline'") {{ provider.enabled ? '启用' : '停用' }}
                Badge(variant="outline") {{ provider.has_key ? '已配置密钥' : '无密钥' }}
  ProviderCreateDialog(v-if="createOpen" v-model:open="createOpen" @created="created")
</template>
